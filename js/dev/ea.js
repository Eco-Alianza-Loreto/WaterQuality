"use strict";
/*
 * Retrieves water quality info from a Google spreadsheet, then displays it
 * on a map. Clicking on one of the flags brings up a popup with details.
 *
 * Tom Keffer 2013-12-16
 *
 */

// How old a sample can be and still be used to determine water
// quality (in milliseconds):
var max_age = 15 * 24 * 3600 * 1000;  // = 15 days

// Initial zoom level for the map
var initial_zoom = 11;

// The cutoffs for bacterial counts:
var bact_good = 99;
var bact_caution = 199;

// Flags to be used as markers.
var flags = {
    'unknown': 'images/unknown.png',
    'good': 'images/good.png',
    'caution': 'images/caution.png',
    'unhealthy': 'images/unhealthy.png'
};

// Shape of the clickable polygon around each marker
var shape = {
    coord: [1, 1, 1, 20, 18, 20, 18 , 1],
    type: 'poly'
};

// These will hold the compiled Handlebars templates
var description_template = null;
var data_template = null;

/*
 * SiteInfo object: Holds all site relevant information, such
 * as lat, lon, description, and data.
 */
var SiteInfo = function (options) {
    this.site_name = options["sitio"];
    this.latitude = options["latitud"];
    this.longitude = options["longitud"];
    this.description = options["descripción"];
};

SiteInfo.prototype = {

    /*
     * extract_data: Filter the provided data array, and
     * extract any data that matches my site name.
     */
    extract_data: function (data_array) {
        var site_name = this.site_name;
        this.data = data_array.filter(function (data_row) {
            return site_name == data_row["sitio"];
        });
    },

    /*
     * ordered_data: Return an Array holding my data in the order
     * of the provided column names.
     */
    ordered_data: function (column_names) {
        var od = [];
        $.each(this.data, function (inx, row_data) {
            var row_array = [];
            $.each(column_names, function (jnx, var_name) {
                row_array.push(row_data[var_name]);
            });
            od.push(row_array);
        });
        return od;
    }
};

/*
 * Entry point
 */
function do_ea(data_key, label_key) {

    // We can start right away with accessing the spreadsheet data,
    // because it does not depend on the DOM being constructed yet.
    // First, start get the data spreadsheet as a deferred:
    var data_deferred = $.Deferred();
    Tabletop.init({key: data_key,
        callback: data_deferred.resolve,
        simpleSheet: false,
        wanted: ['datos', 'sitios']
    });

    // Next, get the label spreadsheet as a deferred:
    var label_deferred = $.Deferred();
    Tabletop.init({key: label_key,
        callback: label_deferred.resolve,
        simpleSheet: false,
        wanted: ['etiquetas']
    });

    // Wait until both the data and labels have been fetched,
    // then process the data and draw the map
    $.when(data_deferred, label_deferred).then(function (data_result, label_result) {
            // Unpack the results from the deferreds, then pass on to process_data:
            draw_map(data_result[0], label_result[0]);
        }
    );
}

// This function will be used to process the spreadsheet data and draw the map
function draw_map(data_spreadsheet, label_spreadsheet) {

    // Get the center of all the sites, then render the Google
    // map around that
    var latlon = get_center(data_spreadsheet.sitios.elements);

    // Defer drawing the map until the document is ready:
    google.maps.event.addDomListener(window, 'load', function () {

        var map = new google.maps.Map(document.getElementById('map-canvas'),
            { zoom: initial_zoom,
                center: latlon});

        // Now that the DOM is ready, we can get and compile the Handlebars templates
        description_template = new Handlebars.compile($("#description-template").html());
        data_template = new Handlebars.compile($("#data-template").html());

        // Gather all the label tags for the measurement types to be displayed
        var label_tags = [];
        $.each(label_spreadsheet.etiquetas.column_names, function (inx, var_name) {
            label_tags.push(label_spreadsheet.etiquetas.elements[0][var_name]);
        });

        // This holds the names of the measurement types to be displayed,
        // as well as the labels used to tag them.
        var measurements = {"names": label_spreadsheet.etiquetas.column_names,
            "labels": label_tags};

        // For each sampling site, build a SiteInfo object
        $.each(data_spreadsheet.sitios.elements, function (inx, this_site) {

            var site_info = new SiteInfo(this_site);
            // Extract any data for this site from the data spreadsheet:
            site_info.extract_data(data_spreadsheet.datos.elements);

            // Mark the site on the map
            mark_site(map, site_info, measurements);
        });
    });

}

/*
 * Mark the map with a flag at the location of the sampling site, and attach a popup
 * window to the flag.
 */
function mark_site(map, site_info, measurements) {

    // Make sure the site has a valid latitude & longitude
    if (site_info.latitude == null || site_info.longitude == null) {
        console.log(site_info.site, " location unknown.");
        return
    }
    var site_latlon = new google.maps.LatLng(site_info.latitude, site_info.longitude);

    // Get the quality summary for this site:
    var q_summary = get_health_summary(site_info.data, max_age);

    // The icon data for the site marker
    var icon_data = {
        url: flags[q_summary],
        // This marker is 20 pixels wide by 32 pixels tall.
        size: new google.maps.Size(20, 32),
        // The origin for this image is 0,0.
        origin: new google.maps.Point(0, 0),
        // The anchor for this image is the base of the flagpole at 0,32.
        anchor: new google.maps.Point(0, 32)
    };

    // Now build the marker using the above data:
    var marker = new google.maps.Marker({
        position: site_latlon,
        map: map,
        icon: icon_data,
        shape: shape,
        title: site_info.site_name
    });

    attach_window(marker, site_info, measurements);
}

var infowindow = null;

function attach_window(marker, site_info, measurements) {
    /*
     * Put a message in an InfoWindow, then associate it with a marker.
     */
    google.maps.event.addListener(marker, 'click', function () {
        // If a window is already open, close it.
        if (infowindow) {
            infowindow.close();
        }

        // This binds all the site information together in a convenient
        // object so the Handlebars template can reference them.
        var site_binder = {
            "site_info": site_info,
            "measurements": measurements,
            "data_rows": site_info.ordered_data(measurements.names)
        };

        // Open up an InfoBubble window and populate it with a couple of tabs:
        infowindow = new InfoBubble();
        infowindow.addTab('Description', description_template(site_binder));
        infowindow.addTab('Data', data_template(site_binder));
        infowindow.open(marker.map, marker);
    });
}

function get_center(sites) {
    // Calculate the center of all the sampling sites.

    var lat_sum = 0.0;
    var lon_sum = 0.0;
    var count = 0;
    var center;

    $.each(sites, function (index, site) {
        lat = parseFloat(site["latitud"]);
        lon = parseFloat(site["longitud"]);
        // Check to make sure this is a valid lat/lon
        if (isNaN(lat) || isNaN(lon) || !lat || !lon)
            return;
        lat_sum += lat;
        lon_sum += lon;
        count += 1;
    });

    if (count) {
        var lat = lat_sum / count;
        var lon = lon_sum / count;
        center = new google.maps.LatLng(lat, lon);
    }
    else {
        // If there are no valid sites, then use a default
        center = new google.maps.LatLng(26.0, -111.3);
    }
    return center;

}

var right_now = new Date().getTime();

function get_health_summary(site_data, stale) {
    /*
     * For this site, determine the whether the water quality
     * is 'good', 'caution', or 'unhealthy'. If the sample is too
     * old, or missing, then it's 'unknown'.
     */

    var last_t = 0;
    var last_row;

    $.each(site_data, function (inx, site_row) {
        var t = Date.parse(site_row["fecha"]);
        if (!isNaN(t)) {
            if (t > last_t) {
                // Record the time and the row
                last_t = t;
                last_row = site_row;
            }
        }
    });

    if (last_t < right_now - stale) {
        // Too old
        return 'unknown';
    }

    var bact_val = last_row["enterococos"];

    if (bact_val == null) {
        return 'unknown';
    }
    else if (bact_val <= bact_good) {
        return 'good';
    }
    else if (bact_val <= bact_caution) {
        return 'caution';
    }
    else {
        return 'unhealthy';
    }
}

