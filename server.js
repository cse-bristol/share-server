
"use strict";

/*global module, require, process*/

var sharejs = require('share'),
    _ = require("lodash"),
    livedb = sharejs.db,
    express = require('express'),
    server = express(),
    Duplex = require('stream').Duplex,
    browserChannel = require('browserchannel').server,
    liveDBMongo = require('livedb-mongo'),
    mongoConnect = liveDBMongo('mongodb://localhost:27017/share?auto_reconnect', {safe:true}),
    backend = livedb.client(mongoConnect),
    share = sharejs.server.createClient({backend: backend}),
    port = function() {
	if (process.argv.length === 3) {
	    return parseInt(process.argv[2]);
	} else {
	    return 8080;
	}
    }();

/*
 Add an HTTP handler for querying. This must happen first.
 */
server.get(
    "/channel/search/:collection",
    function(req, res, next) {
	if (req.query.q === undefined) {
	    res.status(400).send("Expected a query string parameter q containing a search term.");
	} else {
	    backend.queryFetch(
		req.params.collection,
		{
		    _id:
		    {
			$regex: req.query.q
		    }
		},
		{},
		function(error, results) {
		    if (error) {
			next(error);
		    } else {
			res.send(_.pluck(results, "docName"));
		    }
		}
	    );
	}
    }
);

/*
 Add our ShareJS middleware. This is used for long running XHR communication with the browser.

 It lets us keep our documents syncrhonized.
 */
server.use(
    browserChannel(
	function(client) {
	    var stream = new Duplex({objectMode: true});

	    stream._read = function() {};
	    stream._write = function(chunk, encoding, callback) {
		if (client.state !== 'closed') {
		    client.send(chunk);
		}
		callback();
	    };

	    client.on('message', function(data) {
		stream.push(data);
	    });

	    client.on('close', function(reason) {
		stream.push(null);
		stream.emit('close');
	    });

	    stream.on('end', function() {
		client.close();
	    });

	    return share.listen(stream);
	}));

server.listen(port);

