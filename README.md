# leaflet-geotiff-3-alpha

A [LeafletJS](http://www.leafletjs.com) plugin for 3/4 dimentional filtering (pyramid-resolution, viewport-width, viewport-height, and band) and display of geoTIFF raster data in leaflet.

Ready for further testing, development, beautifying and updating.

## Alpha version Notice

As of version 1, `leaflet-geotiff-3-alpha` is under [CSIRO](https://www.csiro.au)'s [Open Source Software Licence Agreement](LICENSE.md), which is a variation of the BSD / MIT License.

There are no other plans for changes to licensing, and the project will remain open source.

---

## Instructions

### 1. Dependencies

Dependencies must be loaded:

- [Leaflet >= 0.7.7](http://leafletjs.com)
- [geotiff.js == 1.0.0-beta.13](https://github.com/constantinius/geotiff.js)
- [plotty >= 0.4.4](https://github.com/santilland/plotty) (optional)
- [turf.js](https://turfjs.org/)
- A http server (cloud optimised geotiffs are spatially filtered using a http range request)


### 2. Preparing COGS for display

Note this will only work with ESPG:4326 tiffs. Useful documentation below:

https://geoexamples.com/other/2019/02/08/cog-tutorial.html
https://observablehq.com/@tmcw/cloud-optimized-geotiffs
https://gis.stackexchange.com/questions/206509/how-are-geotiff-pyramids-overviews-standardised/255847#255847
https://gdal.org/programs/gdal_translate.html
https://gdal.org/drivers/raster/index.html#raster-drivers

Cloud Optimised GeoTiffs need to be generated correctly, with pyramids if required (recommended), and may need resampling to ESPG:4326 before being displayable/queryable directly using this script. Familiarity with GDAL is required.

[gdal warp](https://gdal.org/programs/gdalwarp.html)
[gdaladdo](https://gdal.org/programs/gdaladdo.html)

#### 2.1: Generate the pryramids internally in the tiff file
This will overwrite your original tiff file so save that first. It makes making the filesize itself larger in the process as it makes the tiff a multi-page file with a scaled down version of the raster at each file
Note: be careful the resampling method is appropriate for the data type:

```$ gdaladdo -r nearest //input/file/location 2 4 8 16 32```
 
Essentially asking for the raster to be resampled at intervals and saving the outputs within the existing file.

#### 2.2: Convert the geotiff to a Cloud Optimised Geotiff with the pyramids intact and internally referenced
  
```$ gdal_translate -strict -mo META-TAG=VALUE -a_srs EPSG:4326 -of GTiff -if GTiff //input/file/location //output/file/location -co COMPRESS=LZW -co TILED=YES -co COPY_SRC_OVERVIEWS=YES```


### 3. Add your geoTIFF layer

Parameters:

```javascript
// GeoTIFF file URL. Currently only EPSG:4326 files are supported
// Can be null if sourceFunction is GeoTIFF.fromArrayBuffer
const url =
  "https://stuartmatthews.github.io/leaflet-geotiff/tif/wind_speed.tif";
const options = {
  // See renderer sections below.
  // One of: L.LeafletGeotiff.rgb, L.LeafletGeotiff.plotty, L.LeafletGeotiff.vectorArrows
  renderer: null,

  // Use a worker thread for some initial compute (recommended for larger datasets)
  useWorker: false,

  // Optional array specifying the corners of the data, e.g. [[40.712216, -74.22655], [40.773941, -74.12544]].
  // If omitted the image bounds will be read from the geoTIFF file (ModelTiepoint).
  bounds: [],

  // Optional geoTIFF band to read
  band: 0,

  // Optional geoTIFF sub-image pyramid to read
  image: 0,
  
  //An array of viewport corner coordinates to feed to the raster for use in filtering
  subset: [],

  // Optional clipping polygon, provided as an array of [lat,lon] coordinates.
  // Note that this is the Leaflet [lat,lon] convention, not geoJSON [lon,lat].
  clip: undefined,

  // Optional leaflet pane to add the layer.
  pane: "overlayPane",

  // Optional callback to handle failed URL request or parsing of tif
  onError: null,

  // Optional, override default GeoTIFF function used to load source data
  // Oneof: fromUrl, fromBlob, fromArrayBuffer
  sourceFunction: GeoTIFF.fromUrl,

  // Only required if sourceFunction is GeoTIFF.fromArrayBuffer
  arrayBuffer: null,

  // Optional nodata value (integer)
  // (to be ignored by getValueAtLatLng)
  noDataValue: undefined,

  // Optional key to extract nodata value from GeoTIFFImage
  // nested keys can be provided in dot notation, e.g. foo.bar.baz
  // (to be ignored by getValueAtLatLng)
  // this overrides noDataValue, the nodata value should be an integer
  noDataKey: undefined,

  // The block size to use for buffer
  blockSize: 65536,

  // Optional, override default opacity of 1 on the image added to the map
  opacity: 1,

  // Optional, hide imagery while map is moving (may prevent 'flickering' in some browsers)
  clearBeforeMove: false,
};

// create layer
var layer = L.leafletGeotiff(url, options).addTo(map);
```

Methods - L.leafletGeotiff

| method             | params                           | description                                                 |
| ------------------ | -------------------------------- | ----------------------------------------------------------- |
| `getBounds`        |                                  | get leaflet LatLngBounds of the layer                       |
| `getMinMax`        |                                  | get min max values in data (ignores noDataValue if defined) |
| `getValueAtLatLng` | (`lat: {Number}, lng: {Number}`) | get raster value at a point\*                               |

---

## Renderer - Plotty

Useful for single-band raster data.

```javascript
const options = {
  // Optional. Minimum values to plot.
  displayMin: 0,
  // Optional. Maximum values to plot.
  displayMax: 1,
  // Optional flag for plotty to enable/disable displayMin/Max.
  applyDisplayRange: true,
  // Optional. If true values outside `displayMin` to `displayMax` will be rendered as if they were valid values.
  clampLow: true,
  clampHigh: true,
  // Optional. Plotty color scale used to render the image.
  colorScale: "viridis",
};

const renderer = L.LeafletGeotiff.plotty(options);
```

Methods - leafletGeotiff.plotty

| method                | params                                       | description                                                    |
| --------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `setColorScale`       | (`colorScale: {String}`)                     | set layer color scale                                          |
| `setDisplayRange`     | (`min: {Number}, max: {Number}`)             | set layer display range                                        |
| `setClamps`           | (`clampLow: {Boolean}, clampLow: {Boolean}`) | set layer clamp options                                        |
| `getColourbarDataUrl` | (`paletteName: {String}`)                    | get a data URI for a color palette (e.g. to display colorbar). |
| `getColorbarOptions`  |                                              | get list of available color palettes                           |

New color scales can be created using [plotty's](https://github.com/santilland/plotty) `addColorScale` method.

---

## Renderer - RGB

Useful for multi-band raster data (e.g. true color).

RGB renderer options must currently be added by extending `L.leafletGeotiff` options.

```javascript
const renderer = L.LeafletGeotiff.rgb();

const options = {
  // Optional, band index to use as R-band
  rBand: 0,
  // Optional, band index to use as G-band
  gBand: 1,
  // Optional, band index to use as B-band
  bBand: 2,
  // band index to use as alpha-band
  // NOTE: this can also be used in combination with transpValue, then referring to a
  // color band specifying a fixed value to be interpreted as transparent
  alphaBand: 0,
  // for all values equal to transpValue in the band alphaBand, the newly created alpha
  // channel will be set to 0 (transparent), all other pixel values will result in alpha 255 (opaque)
  transpValue: 0,
  renderer: renderer,
};

// create layer
var layer = L.leafletGeotiff(url, options).addTo(map);
```

---

## Renderer - Vector Arrows

For plotting velocity (i.e. quiver plot)

```javascript
const options = {
  // Optional, size in pixels of direction arrows for vector data.
  arrowSize: 20,
};

const renderer = L.LeafletGeotiff.vectorArrows(options);
```

---

## Advanced usage options

1. Custom renderer can be implemented by extending `L.LeafletGeotiffRenderer`.

## License

CSIRO Open Source Software Licence Agreement (variation of the BSD / MIT License)
