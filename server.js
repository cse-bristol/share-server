"use strict";

/*global module, require, process*/

var sharejs = require('share'),
    json0 = require("ot-json0").type,
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
			res.send(
			    _.pluck(results, "docName")
			);
		    }
		}
	    );
	}
    }
);

/*
 Only works for documents with the JSON0 type.
 */
server.get(
    "/channel/history/:collection/:document/:version",
    function(req, res, next) {
	var v = parseFloat(req.params.version),
	    docName = req.params.document,
	    coll = req.params.collection,
	    finishedDoc,
	    latestVersion,
	    tryRespond = function() {
		if (finishedDoc && latestVersion) {
		    res.send({
			doc: finishedDoc,
			v: v,
			latestV: latestVersion
		    });
		}
	    };

	backend.snapshotDb.getVersion(
	    coll,
	    docName,
	    function(error, v) {
		if (error) {
		    next(error);
		} else {
		    latestVersion = v;
		    tryRespond();
		}
	    }
	);
	
	backend.getOps(
	    coll,
	    docName,
	    0,
	    // Make sure the end version is included.
	    v + 1,
	    function(error, opsToVersion) {
		if (error) {
		    next(error);
		} else if (v > opsToVersion.length) {
		    res.status(404).send("Version " + v + " of " + docName + " does not exist.");
		    
		} else {
		    var doc,
			lastCreateIndex,
			lastDeleteIndex;

		    opsToVersion.forEach(function(op, i) {
			if (op.create) {
			    doc = json0.create(
				op.create.data
			    );
			    lastCreateIndex = i;
			}
			if (op.del) {
			    lastDeleteIndex = i;
			}
		    });

		    if (doc === undefined) {
			next("Could not find a create operation for " + docName);
		    } else if (lastDeleteIndex > lastCreateIndex) {
			res.status(404).send("Document " + docName + " was deleted at v" + lastDeleteIndex);
		    } else {
			/* 
			 Filter out the create operation (which we've already done) and everything which went before it.
			 */
			opsToVersion = opsToVersion.slice(lastCreateIndex + 1);

			for (var i = opsToVersion.length - 1; i >= 0; i--) {
			    doc = json0.apply(
				doc,
				opsToVersion[i]
				    .op[0]
			    );
			}
			
			finishedDoc = doc;
			tryRespond();
		    }
		}
	    }
	);
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

