(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(require('geotiff/dist-browser/geotiff')) :
  typeof define === 'function' && define.amd ? define(['geotiff/dist-browser/geotiff'], factory) :
  (global = global || self, factory(global.GeoTIFF));
}(this, (function (GeoTIFF) { 'use strict';

    // https://github.com/ScanEx/Leaflet.imageTransform/blob/master/src/L.ImageTransform.js
    // https://github.com/BenjaminVadant/leaflet-ugeojson

    // Depends on:
    // https://github.com/constantinius/geotiff.js
    // Note this will only work with ESPG:4326 tiffs

    //####################### Generating COGs for display:
    // Cloud Optimised GeoTiffs need to be generated correctly, with pyramids if required (recommended), and may need resampling to ESPG:4326 before being displayable/queryable directly using this script.
    // gdal warp https://gdal.org/programs/gdalwarp.html
    // gdaladdo https://gdal.org/programs/gdaladdo.html
    /*
      1: Generate the pryramids internally in the tiff file
      This will overwrite your original tiff file so save that first. It makes making the filesize itself larger in the process as it makes the tiff a multi-page file with a scaled down version of the raster at each file
      Note: be careful the resampling method is appropriate for the data type
        $ gdaladdo -r nearest //input/file/location 2 4 8 16 32
      Essentially asking for the raster to be resampled at intervals and saving the outputs within the existing file.

      2: Convert the geotiff to a Cloud Optimised Geotiff with the pyramids intact and internally referenced
      $ gdal_translate -strict -mo META-TAG=VALUE -a_srs EPSG:4326 -of GTiff -if GTiff //input/file/location //output/file/location -co COMPRESS=LZW -co TILED=YES -co COPY_SRC_OVERVIEWS=YES
    */
    // https://geoexamples.com/other/2019/02/08/cog-tutorial.html
    // https://observablehq.com/@tmcw/cloud-optimized-geotiffs
    // https://gis.stackexchange.com/questions/206509/how-are-geotiff-pyramids-overviews-standardised/255847#255847
    // https://gdal.org/programs/gdal_translate.html
    // https://gdal.org/drivers/raster/index.html#raster-drivers

    //####################### Rory Hodgson @ HR Wallingford additions include:
    // calculating and passing viewport bounds to leaflet-geotiff.js
    // translating viewport bounds to a subset of the raster pixels and returning only that subset part of the main raster
    // collecting a lower-resultion resampled pyramid image

    //####################### Caveats:
    // untested with plotty arrow rendering
    // very-much a work in progress
    // In need of some tweaking on rasters that cross meridians

  try {
    new window.ImageData(new Uint8ClampedArray([0, 0, 0, 0]), 1, 1);
  } catch (e) {
    var ImageDataPolyfill = function ImageDataPolyfill() {
      var args = [].concat(Array.prototype.slice.call(arguments)),
          data = void 0;

      if (args.length < 2) {
        throw new TypeError('Failed to construct "ImageData": 2 arguments required, but only ' + args.length + " present.");
      }

      if (args.length > 2) {
        data = args.shift();

        if (!(data instanceof Uint8ClampedArray)) {
          throw new TypeError('Failed to construct "ImageData": parameter 1 is not of type "Uint8ClampedArray"');
        }

        if (data.length !== 4 * args[0] * args[1]) {
          throw new Error('Failed to construct "ImageData": The input data byte length is not a multiple of (4 * width * height)');
        }
      }

      var width = args[0],
          height = args[1],
          canvas = document.createElement("canvas"),
          ctx = canvas.getContext("2d"),
          imageData = ctx.createImageData(width, height);
      if (data) imageData.data.set(data);
      return imageData;
    };

    window.ImageData = ImageDataPolyfill;
  }

  L.LeafletGeotiff = L.ImageOverlay.extend({
    options: {
      arrayBuffer: null,
      arrowSize: 20,
      band: 0,
      image: 0,
      renderer: null,
      rBand: 0,
      gBand: 1,
      bBand: 2,
      alphaBand: 0,
      // band to use for (generating) alpha channel
      transpValue: 0,
      // original band value to interpret as transparent
      pane: "overlayPane",
      onError: null,
      sourceFunction: null,
      noDataValue: undefined,
      noDataKey: undefined,
      useWorker: false
    },

    initialize(url, options) {

        if (typeof window.GeoTIFF === "undefined") {
          throw new Error("GeoTIFF not defined");
        }

        let GeoTIFF = window.GeoTIFF
        //console.log(GeoTIFF);

        this._url = url;
        this.raster = {};
        this.sourceFunction = GeoTIFF.fromUrl;
        this._blockSize = 65536;
        this.x_min = null;
        this.x_max = null;
        this.y_min = null;
        this.y_max = null;
        this.min = null;
        this.max = null;
        L.Util.setOptions(this, options);

        if (this.options.bounds) {
          this._rasterBounds = L.latLngBounds(this.options.bounds);
        }

        if (this.options.renderer) {
          this.options.renderer.setParent(this);
        }

        if (this.options.sourceFunction) {
          this.sourceFunction = this.options.sourceFunction;
        }

        if (this.options.blockSize) {
          this._blockSize = this.options.blockSize;
        }

        this._getData();
    
    },

    setURL(newURL) {
      this._url = newURL;
      this._getData();
    },

    onAdd(map) {
      this._map = map;

      if (!this._image) {
        this._initImage();
      }

      this._image.style.opacity = this.options.opacity || 1;

      map._panes[this.options.pane].appendChild(this._image);

      map.on("moveend", this._reset, this);

      if (this.options.clearBeforeMove) {
        map.on("movestart", this._moveStart, this);
      }

      if (map.options.zoomAnimation && L.Browser.any3d) {
        map.on("zoomanim", this._animateZoom, this);
      }

      this._reset();
    },

    onRemove(map) {
      map.getPanes()[this.options.pane].removeChild(this._image);
      map.off("moveend", this._reset, this);

      if (this.options.clearBeforeMove) {
        map.off("movestart", this._moveStart, this);
      }

      if (map.options.zoomAnimation) {
        map.off("zoomanim", this._animateZoom, this);
      }
    },

    async _getData() {
      let tiff;

      if (this.sourceFunction !== window.GeoTIFF.fromArrayBuffer) {
        tiff = await this.sourceFunction(this._url, {
          blockSize: this._blockSize
        }).catch(e => {
          if (this.options.onError) {
            this.options.onError(e);
          } else {
            console.error(`Failed to load from url or blob ${this._url}`, e);
            return false;
          }
        });
        this._processTIFF(tiff);
        return true;
      } else {
        tiff = await GeoTIFF.fromArrayBuffer(this.options.arrayBuffer, {
          blockSize: this._blockSize
        }).catch(e => {
          if (this.options.onError) {
            this.options.onError(e);
          } else {
            console.error(`Failed to load from array buffer ${this._url}`, e);
            return false;
          }
        });
        this._processTIFF(tiff);
        return true;
      }

    },



    async _processTIFF(tiff) {
      this.tiff = tiff;
      console.log(this.options)
      await this.setBand(this.options.band).catch(e => {
        //console.log(this.options)
        console.error("this.setBand threw error", e);
      });

      if (!this.options.bounds) {//only runs if bounds are not supplied
        const image = await this.tiff.getImage(this.options.image).catch(e => {
          console.error("this.tiff.getImage threw error", e);
        });
        const meta = await image.getFileDirectory(); console.log("meta", meta);

        try {
          let origin = image.getOrigin();
          let bounds = image.getBoundingBox();
          this.x_min = bounds[0];
          this.x_max = bounds[2];
          this.y_min = bounds[1];
          this.y_max = bounds[3];
        } catch (e) {
          console.debug("No bounds supplied, and unable to parse bounding box from metadata.");
          if (this.options.onError) this.options.onError(e);
        }

        this._rasterBounds = L.latLngBounds([[this.y_min, this.x_min], [this.y_max, this.x_max]]);

        //console.log(this._rasterBounds)

        if (this.options.noDataKey) {
          this.options.noDataValue = this.getDescendantProp(image, this.options.noDataKey);
        }

        this._reset();

        if (window.Worker && this.options.useWorker) {
          const worker_src = "onmessage = function(e){let data = e.data.data; let noDataValue = e.data.noDataValue; let min = data.filter(val=> val !== noDataValue).reduce((a,b)=>Math.min(a,b)); let max = data.filter(val => val !== noDataValue).reduce((a,b)=>Math.max(a,b)); postMessage({min:min, max:max});}";
          const blob = new Blob([worker_src], {
            type: 'application/javascript'
          });
          const worker = new Worker(URL.createObjectURL(blob));

          worker.onmessage = e => {
            this.min = e.data.min;
            this.max = e.data.max;
            console.log("worker terminated", e);
            worker.terminate();
          };

          worker.postMessage({
            data: this.raster.data[0],
            noDataValue: this.options.noDataValue
          });
        } else {
          this.min = this.raster.data[0].reduce((a, b) => b === this.options.noDataValue ? a : Math.min(a, b));
          this.max = this.raster.data[0].reduce((a, b) => b == this.options.noDataValue ? a : Math.max(a, b));
        }
      }
    },

    async setBand(band) {
      this.raster.subset = [];

      //gdal doesn't write out the affine transformation (geoKeys) metadata and related outputs for each of the pyramid subimages
      //QGIS forgives this and reads what it needs from the main (0) image into the subimages
      //Leflet.geotiff however does not, so we rectify that here
      //We need to fetch the affine geokeys from the original and then inject them to the subimage data
      
      //always fetch the mainimage metadata, so we can pass this down to the subimages in leaflet.geotiff
      const mainimage = await this.tiff.getImage(0).catch(e => {
        console.error("this.tiff.getImage threw error", e);
      });

      let image = mainimage

      //if its is a subfile we want to write the geoKeys out to it from the mainimage
      if (this.options.image !=0){
        this.tiff.fileDirectories.forEach(internalsubfile => {
          internalsubfile[1] = this.tiff.fileDirectories[0][1]
        });

        //we overwite the image variable with the subfile once we have the corect metadata from the parent
        image = await this.tiff.getImage(this.options.image).catch(e => {
          console.error("this.tiff.getImage threw error", e);
        });

        //copy across the geokeys from the main image metadata
        image.geoKeys = mainimage.geoKeys
      }

      //Now we can read the headers of whichever main/subimage is returned in the same way
      const width = image.getWidth();
      const height = image.getHeight();
      const tileWidth = image.getTileWidth();
      const tileHeight = image.getTileHeight();
      const samplesPerPixel = image.getSamplesPerPixel();

      //we need to write the following objects manually if the geotiff requested is a subfile
      if (this.options.image !=0){
        //Once we have a full set of these metadata written our subfiles will load in leaflet
        image.fileDirectory.GDAL_METADATA = mainimage.fileDirectory.GDAL_METADATA
        image.fileDirectory.GDAL_NODATA = mainimage.fileDirectory.GDAL_NODATA
        image.fileDirectory.GeoAsciiParams = mainimage.fileDirectory.GeoAsciiParams
        image.fileDirectory.GeoAsciiParams = mainimage.fileDirectory.GeoAsciiParams
        image.fileDirectory.GeoDoubleParams = mainimage.fileDirectory.GeoDoubleParams
        image.fileDirectory.GeoKeyDirectory = mainimage.fileDirectory.GeoKeyDirectory
        image.fileDirectory.ModelPixelScale = []

        //If the Geotiff has a set of pyramids (defined in options.image), and only one of these has been requested, we define the scaling factor here
        let factor = 0
        if (this.options.image === 1){ factor=2 }
        if (this.options.image === 2){ factor=4 }
        if (this.options.image === 3){ factor=8 }
        if (this.options.image === 4){ factor=16 }
        if (this.options.image === 5){ factor=32 }
        if (this.options.image === 6){ factor=64 }
        if (this.options.image === 7){ factor=128 }
        //This helps us in the drawing of the raster overlay onscreen later
        image.fileDirectory.ModelPixelScale[0] = mainimage.fileDirectory.ModelPixelScale[0]*factor
        image.fileDirectory.ModelPixelScale[1] = mainimage.fileDirectory.ModelPixelScale[1]*factor
        //There is only ever one tiepoint set of lat/lngs referenced in the geotiff - the topleft corner of the main, fullsized image
        image.fileDirectory.ModelTiepoint = mainimage.fileDirectory.ModelTiepoint 
      }
      
      // when we are actually dealing with geo-data the following methods return
      // meaningful results:
      const origin = image.getOrigin();//top right anchor for whole image
      const resolution = image.getResolution();//resolution per screen pixel
      
      //So we have the subset geometry
      const subsetgeom = this.options.subset;
      //and we have our image boundingbox coordinates
      const bbox = image.getBoundingBox();

      //console.log(width, height)

      //If this is a subset geometry then we've got some work to do
      if(subsetgeom){
        this.getWindowBoundsFromLatLng(subsetgeom, width, height, bbox, image.fileDirectory.ModelPixelScale, image.fileDirectory.ModelTiepoint);
      }
      
      //readrasters actually gets the image data
      const data = await image.readRasters({
        samples: [this.options.band],
        window: this.raster.rasterSubset//[left, top, right, bottom]
      }).catch(e => {
        console.error("image.readRasters threw error", e);
      });

      //refers specifically to rgb bands
      const r = data[this.options.rBand];
      const g = data[this.options.gBand];
      const b = data[this.options.bBand]; // map transparency value to alpha channel if transpValue is specified

      const a = this.options.transpValue ? data[this.options.alphaBand].map(v => {
        return v == this.options.transpValue ? 0 : 255;
      }) : data[this.options.alphaBand];
      this.raster.data = [r, g, b, a].filter(function (v) {
        return v;
      });

      this.raster.width = image.getWidth();
      this.raster.height = image.getHeight();
      
      //We reset the width and height of the image based on the subset requested
      if(subsetgeom){
        this.raster.width = this.raster.rasterSubset[2] - this.raster.rasterSubset[0];
        this.raster.height = this.raster.rasterSubset[3] - this.raster.rasterSubset[1];
      }

      this._reset();

      console.log(image)

      return true;
    },

    //"bounds: [coordinate array]" in leaflet-geotiff.js define where to position the output raster - this is the easy bit.
    //"window: [left, top, right, bottom]" bounds in geotiff.js define tha basis for file-based filtering of the raster data - this is the harder bit.
    getWindowBoundsFromLatLng(subsetgeom, width, height, imgbbox, img_pxsize, img_tiepoint) {
      console.log(subsetgeom, width, height, imgbbox, img_pxsize, img_tiepoint);

      //1: work out the subset geometry (viewport) as a percentage of the raster image
      //Lets clear up the latlng leftright confusion for the image
      var imgTop_Lat = imgbbox[3];
      var imgLeft_Lon = imgbbox[0];
      var imgBottom_Lat = imgbbox[1];
      var imgRight_Lon = imgbbox[2];
      //console.log(imgTop_Lat, imgLeft_Lon, imgBottom_Lat, imgRight_Lon)

      //calculate the horizontal length and vertical height of the whole geotiff image in degrees
      var imgWidthDeg = Math.abs(imgRight_Lon - imgLeft_Lon);
      var imgHeightDeg = Math.abs(imgTop_Lat - imgBottom_Lat);
      console.log('img length deg:' + imgWidthDeg, 'img height deg:'+ imgHeightDeg)

      //Lets clear up the latlng leftright confusion for the subset.
      var subimgTop_Lat = subsetgeom[2][0];
      var subimgLeft_Lon = subsetgeom[0][1];
      var subimgBottom_Lat = subsetgeom[0][0];
      var subimgRight_Lon = subsetgeom[2][1];
      //console.log(subimgTop_Lat, subimgLeft_Lon, subimgBottom_Lat, subimgRight_Lon)

      //calculate the horizontal length and vertical height of the subset bounding box in degrees
      var subimgWidthDeg = subimgRight_Lon - subimgLeft_Lon;
      var subimgHeightDeg = subimgTop_Lat - subimgBottom_Lat;
      console.log('subimg length deg:' + subimgWidthDeg, 'subimg height deg:'+ subimgHeightDeg);

      //now we need to calculate the distance in degrees of our subsets [left, top, right, bottom] in relation to the overall raster image bounds
      //gives us distances in degrees from image boundary
      //IMPORTANT TODO: This will need tweaking for cases when raster crosses/spans meridian or equator
      var subsetBoundsDistanceToRasterTop = Math.abs(imgBottom_Lat - subimgTop_Lat);
      var subsetBoundsDistanceToRasterLeft = Math.abs(imgRight_Lon - subimgLeft_Lon);
      var subsetBoundsDistanceToRasterBottom = Math.abs(subimgBottom_Lat - imgTop_Lat);
      var subsetBoundsDistanceToRasterRight = Math.abs(subimgRight_Lon - imgLeft_Lon);
      //console.log(subsetBoundsDistanceToRasterTop, subsetBoundsDistanceToRasterLeft, subsetBoundsDistanceToRasterBottom, subsetBoundsDistanceToRasterRight);

      //subtract these distances from the known width and height of the raster image
      var subsetDistanceFromRasterTop_Deg = imgHeightDeg - subsetBoundsDistanceToRasterTop;
      var subsetDistanceFromRasterLeft_Deg = imgWidthDeg - subsetBoundsDistanceToRasterLeft;
      var subsetDistanceFromRasterBottom_Deg = imgHeightDeg - subsetBoundsDistanceToRasterBottom;
      var subsetDistanceFromRasterRight_Deg = imgWidthDeg - subsetBoundsDistanceToRasterRight;
      //console.log(subsetDistanceFromRasterTop_Deg, subsetDistanceFromRasterLeft_Deg, subsetDistanceFromRasterBottom_Deg, subsetDistanceFromRasterRight_Deg);

      //We can then calculate these distances as a proportion of the size of the raster
      var percentageDistanceFromRasterTop = (subsetDistanceFromRasterTop_Deg/imgHeightDeg * 100);
      var percentageDistanceFromRasterLeft = (subsetDistanceFromRasterLeft_Deg/imgWidthDeg * 100);
      var percentageDistanceFromRasterBottom = 100 -(subsetDistanceFromRasterBottom_Deg/imgHeightDeg * 100);//we invert the right and bottom
      var percentageDistanceFromRasterRight = 100 - (subsetDistanceFromRasterRight_Deg/imgWidthDeg * 100);
      console.log(percentageDistanceFromRasterTop, percentageDistanceFromRasterLeft, percentageDistanceFromRasterBottom, percentageDistanceFromRasterRight);
    
      //And apply them to the overall width of the geotiff image
      var pixelEquivalentTop = height/100*percentageDistanceFromRasterTop;
      var pixelEquivalentLeft = width/100*percentageDistanceFromRasterLeft;
      var pixelEquivalentBottom = height/100*percentageDistanceFromRasterBottom; 
      var pixelEquivalentRight = width/100*percentageDistanceFromRasterRight;
      //console.log([pixelEquivalentLeft, pixelEquivalentTop, pixelEquivalentRight, pixelEquivalentBottom])

      //We take them back to their whole numbers to ensure a full set of pixels are returned
      this.raster.rasterSubset = [
        Math.trunc(pixelEquivalentLeft), 
        Math.trunc(pixelEquivalentTop), 
        Math.trunc(pixelEquivalentRight), 
        Math.trunc(pixelEquivalentBottom)
      ]

      //NOTE: we are talking about sorting two points here. topleft and botomright, working down from topright

      //We need to know the lat and lng of these new subset boundaries.
      //are these embedded in the file? - not as such but...
      //console.log(width, height, img_pxsize[0], img_pxsize[1], img_tiepoint[3], img_tiepoint[4]) 
      //console.log(this.raster.rasterSubset)

      //main image anchor point topleft
      var mainimg_topanchor = img_tiepoint[3]
      var mainimg_leftanchor = img_tiepoint[4]

      //we can shift our registration points by the number of pixel widths/heights
      var shiftedtop = mainimg_topanchor + this.raster.rasterSubset[0] * img_pxsize[0]
      var shiftedleft = mainimg_leftanchor - this.raster.rasterSubset[1] * img_pxsize[1]
      var shiftedbottom = mainimg_topanchor + (this.raster.rasterSubset[2] * img_pxsize[0])
      var shiftedright = mainimg_leftanchor - (this.raster.rasterSubset[3] * img_pxsize[1])

      console.log([shiftedtop, shiftedleft], [shiftedbottom, shiftedright])

      //and the adjusted bounds are
      this.options.bounds = [
        [shiftedleft,shiftedtop],
        [shiftedleft,shiftedbottom],
        [shiftedright,shiftedbottom],
        [shiftedright,shiftedtop],
        [shiftedleft,shiftedtop]
      ]

      this._rasterBounds = L.latLngBounds(this.options.bounds)
      
      return this.raster.rasterSubset;
    },

    getRasterArray() {
      return this.raster.data;
    },

    getRasterCols() {
      return this.raster.width;
    },

    getRasterRows() {
      return this.raster.height;
    },

    getBounds() {
      return this._rasterBounds;
    },

    getMinMax() {
      return {
        min: this.min,
        max: this.max
      };
    },

    getValueAtLatLng(lat, lng) {
      try {
        var x = Math.floor(this.raster.width * (lng - this._rasterBounds._southWest.lng) / (this._rasterBounds._northEast.lng - this._rasterBounds._southWest.lng));
        var y = this.raster.height - Math.ceil(this.raster.height * (lat - this._rasterBounds._southWest.lat) / (this._rasterBounds._northEast.lat - this._rasterBounds._southWest.lat)); // invalid indices

        if (x < 0 || x > this.raster.width || y < 0 || y > this.raster.height) return null;
        const i = y * this.raster.width + x;
        const value = this.raster.data[0][i];
        if (this.options.noDataValue === undefined) return value;
        const noData = parseInt(this.options.noDataValue);
        if (value !== noData) return value;
        return null;
      } catch (err) {
        return undefined;
      }
    },


    _animateZoom(e) {
      if (L.version >= "1.0") {
        var scale = this._map.getZoomScale(e.zoom),
            offset = this._map._latLngBoundsToNewLayerBounds(this._map.getBounds(), e.zoom, e.center).min;

        L.DomUtil.setTransform(this._image, offset, scale);
      } else {
        var scale = this._map.getZoomScale(e.zoom),
            nw = this._map.getBounds().getNorthWest(),
            se = this._map.getBounds().getSouthEast(),
            topLeft = this._map._latLngToNewLayerPoint(nw, e.zoom, e.center),
            size = this._map._latLngToNewLayerPoint(se, e.zoom, e.center)._subtract(topLeft);

        this._image.style[L.DomUtil.TRANSFORM] = L.DomUtil.getTranslateString(topLeft) + " scale(" + scale + ") ";
      }
    },

    _moveStart() {
      this._image.style.display = 'none';
    },

    _reset() {
      if (this.hasOwnProperty("_map") && this._map) {
        if (this._rasterBounds) {

          let northwest = this._map.getBounds().getNorthWest()
          let southeast = this._map.getBounds().getSouthEast()

          //This controls the final positioning of the image
          var topLeft = this._map.latLngToLayerPoint(northwest),
              size = this._map.latLngToLayerPoint(southeast)._subtract(topLeft);

          L.DomUtil.setPosition(this._image, topLeft);
          this._image.style.width = size.x + "px";
          this._image.style.height = size.y + "px";

          this._drawImage();

          this._image.style.display = 'block';
        }
      }
    },

    setClip(clipLatLngs) {
      this.options.clip = clipLatLngs;

      this._reset();
    },

    _getPixelByLatLng(latLng) {
      var topLeft = this._map.latLngToLayerPoint(this._map.getBounds().getNorthWest());

      var mercPoint = this._map.latLngToLayerPoint(latLng);

      return L.point(mercPoint.x - topLeft.x, mercPoint.y - topLeft.y);
    },

    _clipMaskToPixelPoints(i) {
      if (this.options.clip) {
        var topLeft = this._map.latLngToLayerPoint(this._map.getBounds().getNorthWest());

        var pixelClipPoints = [];
        const clip = this.options.clip[i];

        for (var p = 0; p < clip.length; p++) {
          var mercPoint = this._map.latLngToLayerPoint(clip[p]),
              pixel = L.point(mercPoint.x - topLeft.x, mercPoint.y - topLeft.y);

          pixelClipPoints.push(pixel);
        }

        this._pixelClipPoints = pixelClipPoints;
      } else {
        this._pixelClipPoints = undefined;
      }
    },

    _drawImage() {
      if (this.raster.hasOwnProperty("data")) {
        var args = {};
        
        //By the time we get here the positioning of the raster is not in this.raster
        console.log(this.raster)

        //positioning and size of the raster is defined here
        var topLeft = this._map.latLngToLayerPoint(this._map.getBounds().getNorthWest());
        var size = this._map.latLngToLayerPoint(this._map.getBounds().getSouthEast())._subtract(topLeft);

        args.rasterPixelBounds = L.bounds(this._map.latLngToContainerPoint(this._rasterBounds.getNorthWest()), this._map.latLngToContainerPoint(this._rasterBounds.getSouthEast())); // sometimes rasterPixelBounds will have fractional values
        // that causes transform() to draw a mostly empty image. Convert
        // fractional values to integers to fix this.

        args.rasterPixelBounds.max.x = parseInt(args.rasterPixelBounds.max.x);
        args.rasterPixelBounds.min.x = parseInt(args.rasterPixelBounds.min.x);
        args.rasterPixelBounds.max.y = parseInt(args.rasterPixelBounds.max.y);
        args.rasterPixelBounds.min.y = parseInt(args.rasterPixelBounds.min.y);
        args.xStart = args.rasterPixelBounds.min.x > 0 ? args.rasterPixelBounds.min.x : 0;
        args.xFinish = args.rasterPixelBounds.max.x < size.x ? args.rasterPixelBounds.max.x : size.x;
        args.yStart = args.rasterPixelBounds.min.y > 0 ? args.rasterPixelBounds.min.y : 0;
        args.yFinish = args.rasterPixelBounds.max.y < size.y ? args.rasterPixelBounds.max.y : size.y;
        args.plotWidth = args.xFinish - args.xStart;
        args.plotHeight = args.yFinish - args.yStart;

        if (args.plotWidth <= 0 || args.plotHeight <= 0) {
          var plotCanvas = document.createElement("canvas");
          plotCanvas.width = size.x;
          plotCanvas.height = size.y;
          var ctx = plotCanvas.getContext("2d");
          ctx.clearRect(0, 0, plotCanvas.width, plotCanvas.height);
          this._image.src = plotCanvas.toDataURL();
          return;
        }

        args.xOrigin = this._map.getPixelBounds().min.x + args.xStart;
        args.yOrigin = this._map.getPixelBounds().min.y + args.yStart;
        args.lngSpan = (this._rasterBounds._northEast.lng - this._rasterBounds._southWest.lng) / this.raster.width;
        args.latSpan = (this._rasterBounds._northEast.lat - this._rasterBounds._southWest.lat) / this.raster.height; //Draw image data to canvas and pass to image element

        var plotCanvas = document.createElement("canvas");
        plotCanvas.width = size.x;
        plotCanvas.height = size.y;
        var ctx = plotCanvas.getContext("2d");
        ctx.clearRect(0, 0, plotCanvas.width, plotCanvas.height);
        this.options.renderer.render(this.raster, plotCanvas, ctx, args);
        
        //  mask is causeing problems and seems to be not needed for our implementation
        //  TODO: look into what this is supposed to do and why this doesn't work
        //  seems to just expect a clipping geometry - untested by HRW
        //var mask = this.createMask(size, args);
        //ctx.globalCompositeOperation = 'destination-out';
        //ctx.drawImage(mask, 0, 0);

        this._image.src = String(plotCanvas.toDataURL());
      }
    },

    createSubmask(size, args, clip) {
      var canvas = document.createElement("canvas");
      canvas.width = size.x;
      canvas.height = size.y;
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (var i = 0; i < clip.length; i++) {
        var ring = clip[i];

        if (i > 0) {
          //inner ring
          ctx.globalCompositeOperation = "destination-out";
        }

        ctx.beginPath();

        for (var j = 0; j < ring.length; j++) {
          var pix = this._getPixelByLatLng(ring[j]);

          ctx.lineTo(pix.x, pix.y);
        }

        ctx.fill();
      }

      return canvas;
    },

    createMask(size, args) {
      var canvas = document.createElement("canvas");
      canvas.width = size.x;
      canvas.height = size.y;
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillRect(args.xStart, args.yStart, args.plotWidth, args.plotHeight); //Draw clipping polygon

      const clip = this.options.clip;

      if (clip) {
        ctx.globalCompositeOperation = "destination-out";

        for (var idx = 0; idx < clip.length; idx++) {
          var submask = this.createSubmask(size, args, clip[idx]);
          ctx.drawImage(submask, 0, 0);
        }
      }

      return canvas;
    },

    transform(rasterImageData, args) {
      //Create image data and Uint32 views of data to speed up copying
      var imageData = new ImageData(args.plotWidth, args.plotHeight);
      var outData = imageData.data;
      var outPixelsU32 = new Uint32Array(outData.buffer);
      var inData = rasterImageData.data;
      var inPixelsU32 = new Uint32Array(inData.buffer);

      var zoom = this._map.getZoom();

      var scale = this._map.options.crs.scale(zoom);

      var d = 57.29577951308232; //L.LatLng.RAD_TO_DEG;

      var transformationA = this._map.options.crs.transformation._a;
      var transformationB = this._map.options.crs.transformation._b;
      var transformationC = this._map.options.crs.transformation._c;
      var transformationD = this._map.options.crs.transformation._d;

      if (L.version >= "1.0") {
        transformationA = transformationA * this._map.options.crs.projection.R;
        transformationC = transformationC * this._map.options.crs.projection.R;
      }

      for (var y = 0; y < args.plotHeight; y++) {
        var yUntransformed = ((args.yOrigin + y) / scale - transformationD) / transformationC;
        var currentLat = (2 * Math.atan(Math.exp(yUntransformed)) - Math.PI / 2) * d;
        var rasterY = this.raster.height - Math.ceil((currentLat - this._rasterBounds._southWest.lat) / args.latSpan);

        for (var x = 0; x < args.plotWidth; x++) {
          //Location to draw to
          var index = y * args.plotWidth + x; //Calculate lat-lng of (x,y)
          //This code is based on leaflet code, unpacked to run as fast as possible
          //Used to deal with TIF being EPSG:4326 (lat,lon) and map being EPSG:3857 (m E,m N)

          var xUntransformed = ((args.xOrigin + x) / scale - transformationB) / transformationA;
          var currentLng = xUntransformed * d;
          var rasterX = Math.floor((currentLng - this._rasterBounds._southWest.lng) / args.lngSpan);
          var rasterIndex = rasterY * this.raster.width + rasterX; //Copy pixel value

          outPixelsU32[index] = inPixelsU32[rasterIndex];
        }
      }

      return imageData;
    },

    /**
     * Supports retreival of nested properties via
     * dot notation, e.g. foo.bar.baz
     */
    getDescendantProp(obj, desc) {
      const arr = desc.split(".");

      while (arr.length && (obj = obj[arr.shift()]));

      return obj;
    }

  });
  L.LeafletGeotiffRenderer = L.Class.extend({
    initialize(options) {
      L.setOptions(this, options);
    },

    setParent(parent) {
      this.parent = parent;
    },

    render(raster, canvas, ctx, args) {
      throw new Error("Abstract class");
    }

  });

  L.leafletGeotiff = function (url, options) {
    return new L.LeafletGeotiff(url, options);
  };

})));