$(document).ready(function () {
  // MAP
  const map = L.map("map").setView([17.271,-62.573], 11);;
  L.tileLayer(
    "http://{s}.sm.mapstack.stamen.com/(toner-lite,$fff[difference],$fff[@23],$fff[hsl-saturation@20])/{z}/{x}/{y}.png"
  ).addTo(map);

  //load COG
  const rasterUrl = "classification_cog.tif";

  //define default band to collect
  let CollectBandNo = 0;

  //////////////// event listener for onmove events to recall cloud optimised geotiffs and collect a fresh subset each time
  map.on("moveend", function(s){//when moved
        collectGeoTiffSubset(CollectBandNo);
  });

  //function to be rcalled each time the viewport is altered
  collectGeoTiffSubset = async function(bandNo){

    if (bandNo == undefined) {
      CollectBandNo = 0;
    } else {
      CollectBandNo = bandNo;
    }

    //crude but simple way of removing all raster layers completely, avoiding 'sticky' leaflet layer problem 
    map.eachLayer(function (layer) {
      if (layer.raster){
        map.removeLayer(layer);
      }
    });

    //Get the current zoom
    let zoomlevel = map.getZoom()

    //We define the relevant cog pyramid to collect based on the zoom level - move to a configuration file?
    if (zoomlevel < 13 ){subimageId = 4}//lowest resolution, small file
    else if (zoomlevel >= 13 && zoomlevel < 14 ){subimageId = 3}
    else if (zoomlevel >= 14 && zoomlevel < 15 ){subimageId = 2}
    else if (zoomlevel >= 15 && zoomlevel < 16 ){subimageId = 1}
    else {subimageId = 0}//highest resolution

    //If this is a low-resolution COG example it does not have pyramids so we are always looking at subimageId = 0
    //subimageId = 0

    console.log('subimage id :'+ subimageId)

    //requires turf.js client side geospatial engine

    //use leaflet to get the bounds
    let mapbounds = map.getBounds();

    //use turf to convert bounds to a diagonal linestring. NOTE lat/lng are reversed
    let mapboundsline=turf.lineString([
        [mapbounds.getSouthWest().lng, mapbounds.getSouthWest().lat],
        [mapbounds.getNorthEast().lng, mapbounds.getNorthEast().lat]
    ])

    //then use turf to convert linestring to a geojson polygon
    let bbox = turf.bbox(mapboundsline);
    let bboxPolygon = turf.bboxPolygon(bbox);

    //make a geojson layer from the polygon so we can see what bounds we are clipping to - debug feature
    //var tempdisplay = L.geoJson(bboxPolygon).addTo(BaseMap.map)

    //Get the coordinates of the polygon
    let coords = bboxPolygon.geometry.coordinates[0];

    //we flip these back to lng/lat again before feeding to the subsetting option
    let flippedcoords = [
        [coords[0][1], coords[0][0]],
        [coords[1][1], coords[1][0]],
        [coords[2][1], coords[2][0]],
        [coords[3][1], coords[3][0]],
        [coords[4][1], coords[4][0]]
    ]

    const plottyRenderer = L.LeafletGeotiff.plotty({
      displayMin: 0.01,
      displayMax: 10,
      clampLow: false,
      clampHigh: false,
      colorScale: "ylgnbu",
    });

    rasterLayer = L.leafletGeotiff(rasterUrl, {
      renderer: plottyRenderer,
      sourceFunction: GeoTIFF.fromUrl,
      opacity: 0.5,
      band: 0,
      image: subimageId,//defined by zoom level
      subset: flippedcoords,
    }).addTo(map);

  }

  //initialise the first load of the COG
  collectGeoTiffSubset(CollectBandNo);


  $("#displayMin").on("change", (event) => {
    rasterLayer.options.renderer.setDisplayRange(
      +event.currentTarget.value,
      rasterLayer.options.renderer.options.displayMax
    );
  });
  $("#displayMax").on("change", (event) => {
    rasterLayer.options.renderer.setDisplayRange(
      rasterLayer.options.renderer.options.displayMin,
      +event.currentTarget.value
    );
  });

  $("#clampLow").on("change", (event) => {
    rasterLayer.options.renderer.setClamps(
      event.currentTarget.checked,
      rasterLayer.options.renderer.options.clampHigh
    );
  });

  $("#clampHigh").on("change", (event) => {
    rasterLayer.options.renderer.setClamps(
      rasterLayer.options.renderer.options.clampLow,
      event.currentTarget.checked
    );
  });

  $("#colorScale").on("change", (event) => {
    const colorScale = $("#colorScale option:selected").val();
    rasterLayer.options.renderer.setColorScale(colorScale);
  });

  $("#getBounds").on("click", (event) => {
    event.preventDefault();
    const bounds = rasterLayer.getBounds();
    map.fitBounds(bounds, { maxZoom: 15 });
  });

  $("#getColorbarOptions").on("click", (event) => {
    event.preventDefault();
    const options = rasterLayer.options.renderer.getColorbarOptions();
    console.log("getColorbarOptions", options);
  });

  let popup;
  map.on("click", function (e) {
    if (!popup) {
      popup = L.popup().setLatLng([e.latlng.lat, e.latlng.lng]).openOn(map);
    } else {
      popup.setLatLng([e.latlng.lat, e.latlng.lng]);
    }
    const value = rasterLayer.getValueAtLatLng(+e.latlng.lat, +e.latlng.lng);
    popup
      .setContent(`Possible value at point (experimental/buggy): ${value}`)
      .openOn(map);
  });
});
