"use strict";

/*global module, require, process*/

var sridSearch = require("srid-search")(function(error) {
    console.error(error);
}),
    sharejs = require('share'),
    json0 = require("ot-json0").type,
    _ = require("lodash"),
    livedb = sharejs.db,
    express = require('express'),
    server = express(),
    Duplex = require('stream').Duplex,
    browserChannel = require('browserchannel').server,

    elasticSearchHost = 'http://localhost:9200',
    
    liveDBElasticSearchFactory = require('livedb-elasticsearch'),
    liveDBElasticSearch = liveDBElasticSearchFactory(
	elasticSearchHost,
	'share'
    ),
    backend = livedb.client(liveDBElasticSearch),
    share = sharejs.server.createClient({backend: backend}),
    port = function() {
	if (process.argv.length === 3) {
	    return parseInt(process.argv[2]);
	} else {
	    return 8080;
	}
    }(),

    /*
     We make a separate ElasticSearch client for more manual querying.
     */
    elasticSearch = require('elasticsearch'),
    elasticSearchClient = new elasticSearch.Client({
	host: elasticSearchHost,
	apiVersion: "1.7",
	suggestionCompression: true
    }),
    mediawikiCategoryIndex = 'mediawiki_general_first',
    mediawikiCategoryType = 'page';

/*
 Query Mediawiki's ElasticSearch for categories which belong to Category:Projects.

 Return their titles.
 */
server.get(
    "/channel/projects",
    function(req, res, next) {
	elasticSearchClient.search(
	    {
		index: mediawikiCategoryIndex,
		type: mediawikiCategoryType,
		body: {
		    fields: ['title'],
		    query: {
			filtered: {
			    query: {
				match: {
				    "category.lowercase_keyword": "projects"
				}
			    },
			    filter: {
				term: {
				    namespace_text: "Category"
				}
			    }
			}
		    }
		}
	    },
	    function(error, result) {
		if (error) {
		    next(error);
		    
		} else {
		    res.send(result.hits.hits.map(function(hit) {
			return hit.fields.title[0];
		    }));
		}
	    }
	);
    }
);

/*
 Expose free-text search for coordinate systems.
 */
server.get(
    "/channel/srid-search/:term",
    function(req, res, next) {
	if (req.params.term) {
	    res.send(
		sridSearch(req.params.term));
	} else {
	    res.send();
	}
    }
);

/*
 Add an HTTP handler for querying. This must happen first.
 */
server.get(
    "/channel/search/:collection",
    function(req, res, next) {
	if (req.query.q === undefined) {
	    res.status(400).send("Expected a query string parameter q containing a search term.");
	} else {
	    backend.snapshotDb
		.titleSearch(
		    req.params.collection,
		    req.query.q,
		    function(error, results) {
			if (error) {
			    next(error);
			} else {
			    res.send(
				results.map(
				    function(title) {
					return {
					    name: title
					};
				    }
				)
			    );
			}
			
		    }
		);
	}
    }
);

server.get(
    "/channel/current/:collection/:document",
    function(req, res, next) {
	backend.fetch(
	    req.params.collection,
	    req.params.document.toLowerCase(),
	    function(error, snapshot) {
		if (error) {
		    next(error);
		} else {
		    res.send(snapshot);
		}
	    }
	);
    }
);

server.get(
    "/channel/versions/:collection/:document/:versionsFrom",
    function(req, res, next) {
	var versionsFrom = parseFloat(req.params.versionsFrom),
	    docName = req.params.document.toLowerCase(),
	    coll = req.params.collection;

	backend.snapshotDb
	    .getOps(
		coll,
		docName,
		versionsFrom,
		null,
		function(error, results) {
		    if (error) {
			next(error);
		    } else {
			res.send(
			    results
				.filter(
				    function(op) {
					return !op.del;
				    }
				)
				.map(
				    function(op) {
					return {
					    v: op.v,
					    ts: op.timestamp
					};
				    }
				)
			);
		    }
		    
		}
	    );
    }
);

/*
 Only works for documents with the JSON0 type.
 */
server.get(
    "/channel/history/:collection/:document/:version",
    function(req, res, next) {
	var v = parseFloat(req.params.version),
	    docName = req.params.document.toLowerCase(),
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

			var len = opsToVersion.length;
			for (var i = 0; i < len; i++) {
			    doc = json0.apply(
				doc,
				opsToVersion[i]
				    .op
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

