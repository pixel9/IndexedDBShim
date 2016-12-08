(function(idbModules) {
    'use strict';

    var uniqueID = 0;

    /**
     * The IndexedDB Transaction
     * http://dvcs.w3.org/hg/IndexedDB/raw-file/tip/Overview.html#idl-def-IDBTransaction
     * @param {IDBDatabase} db
     * @param {string[]} storeNames
     * @param {string} mode
     * @constructor
     */
    function IDBTransaction(db, storeNames, mode) {
        this.__id = ++uniqueID; // for debugging simultaneous transactions
        this.__active = true;
        this.__running = false;
        this.__errored = false;
        this.__requests = [];
        this.__storeNames = storeNames;
        this.mode = mode;
        this.db = db;
        this.error = null;
        this.onabort = this.onerror = this.oncomplete = null;

        // Kick off the transaction as soon as all synchronous code is done.
        var me = this;
        setTimeout(function() { me.__executeRequests(); }, 0);
    }

    IDBTransaction.prototype.__executeRequests = function() {
        if (this.__running) {
            idbModules.DEBUG && console.log("Looks like the request set is already running", this.mode);
            return;
        }

        this.__running = true;
        var me = this;

        idbModules.getOpenDatabase(me.db.name, me.db.version, null, function (db) {
            db.transaction(function executeRequests(tx) {
                    me.__tx = tx;
                    var q = null, i = 0;

                    function success(result, req) {
                        if (req) {
                            q.req = req;// Need to do this in case of cursors
                        }
                        q.req.readyState = "done";
                        q.req.result = result;
                        delete q.req.error;
                        var e = idbModules.util.createEvent("success");
                        idbModules.util.callback("onsuccess", q.req, e);
                        i++;
                        executeNextRequest();
                    }

                    function error(tx, err) {
                        err = idbModules.util.findError(arguments);
                        try {
                            // Fire an error event for the current IDBRequest
                            q.req.readyState = "done";
                            q.req.error = err || "DOMError";
                            q.req.result = undefined;
                            var e = idbModules.util.createEvent("error", err);
                            idbModules.util.callback("onerror", q.req, e);
                        }
                        finally {
                            // Fire an error event for the transaction
                            transactionError(err);
                        }
                    }

                    function executeNextRequest() {
                        if (i >= me.__requests.length) {
                            // All requests in the transaction are done
                            me.__requests = [];
                            if (me.__active) {
                                me.__active = false;
                                transactionFinished();
                            }
                        }
                        else {
                            try {
                                q = me.__requests[i];
                                q.op(tx, q.args, success, error);
                            }
                            catch (e) {
                                error(e);
                            }
                        }
                    }

                    executeNextRequest();
                },

                function webSqlError(err) {
                    transactionError(err);
                }
            );
        });

        function transactionError(err) {
            idbModules.util.logError("Error", "An error occurred in a transaction", err);

            if (me.__errored) {
                // We've already called "onerror", "onabort", or thrown, so don't do it again.
                return;
            }

            me.__errored = true;

            if (!me.__active) {
                // The transaction has already completed, so we can't call "onerror" or "onabort".
                // So throw the error instead.
                throw err;
            }

            try {
                me.error = err;
                var evt = idbModules.util.createEvent("error");
                idbModules.util.callback("onerror", me, evt);
                idbModules.util.callback("onerror", me.db, evt);
            }
            finally {
                me.abort();
            }
        }

        function transactionFinished() {
            idbModules.DEBUG && console.log("Transaction completed");
            var evt = idbModules.util.createEvent("complete");
            try {
                idbModules.util.callback("oncomplete", me, evt);
                idbModules.util.callback("__oncomplete", me, evt);
            }
            catch (e) {
                // An error occurred in the "oncomplete" handler.
                // It's too late to call "onerror" or "onabort". Throw a global error instead.
                // (this may seem odd/bad, but it's how all native IndexedDB implementations work)
                me.__errored = true;
                throw e;
            }
        }
    };

    /**
     * Creates a new IDBRequest for the transaction.
     * NOTE: The transaction is not queued util you call {@link IDBTransaction#__pushToQueue}
     * @returns {IDBRequest}
     * @protected
     */
    IDBTransaction.prototype.__createRequest = function() {
        var request = new idbModules.IDBRequest();
        request.source = this.db;
        request.transaction = this;
        return request;
    };

    /**
     * Adds a callback function to the transaction queue
     * @param {function} callback
     * @param {*} args
     * @returns {IDBRequest}
     * @protected
     */
    IDBTransaction.prototype.__addToTransactionQueue = function(callback, args) {
        var request = this.__createRequest();
        this.__pushToQueue(request, callback, args);
        return request;
    };

    /**
     * Adds an IDBRequest to the transaction queue
     * @param {IDBRequest} request
     * @param {function} callback
     * @param {*} args
     * @protected
     */
    IDBTransaction.prototype.__pushToQueue = function(request, callback, args) {
        this.__assertActive();
        this.__requests.push({
            "op": callback,
            "args": args,
            "req": request
        });
    };

    IDBTransaction.prototype.__assertActive = function() {
        if (!this.__active) {
            throw idbModules.util.createDOMException("TransactionInactiveError", "A request was placed against a transaction which is currently not active, or which is finished");
        }
    };

    IDBTransaction.prototype.__assertWritable = function() {
        if (this.mode === IDBTransaction.READ_ONLY) {
            throw idbModules.util.createDOMException("ReadOnlyError", "The transaction is read only");
        }
    };

    IDBTransaction.prototype.__assertVersionChange = function() {
        IDBTransaction.__assertVersionChange(this);
    };

    IDBTransaction.__assertVersionChange = function(tx) {
        if (!tx || tx.mode !== IDBTransaction.VERSION_CHANGE) {
            throw idbModules.util.createDOMException("InvalidStateError", "Not a version transaction");
        }
    };

    /**
     * Returns the specified object store.
     * @param {string} objectStoreName
     * @returns {IDBObjectStore}
     */
    IDBTransaction.prototype.objectStore = function(objectStoreName) {
        if (arguments.length === 0) {
            throw new TypeError("No object store name was specified");
        }
        if (!this.__active) {
            throw idbModules.util.createDOMException("InvalidStateError", "A request was placed against a transaction which is currently not active, or which is finished");
        }
        if (this.__storeNames.indexOf(objectStoreName) === -1 && this.mode !== IDBTransaction.VERSION_CHANGE) {
            throw idbModules.util.createDOMException("NotFoundError", objectStoreName + " is not participating in this transaction");
        }
        var store = this.db.__objectStores[objectStoreName];
        if (!store) {
            throw idbModules.util.createDOMException("NotFoundError", objectStoreName + " does not exist in " + this.db.name);
        }

        return idbModules.IDBObjectStore.__clone(store, this);
    };

    IDBTransaction.prototype.abort = function() {
        var me = this;
        idbModules.DEBUG && console.log("The transaction was aborted", me);
        me.__active = false;
        var evt = idbModules.util.createEvent("abort");

        // Fire the "onabort" event asynchronously, so errors don't bubble
        setTimeout(function() {
            idbModules.util.callback("onabort", me, evt);
        }, 0);
    };

    IDBTransaction.READ_ONLY = "readonly";
    IDBTransaction.READ_WRITE = "readwrite";
    IDBTransaction.VERSION_CHANGE = "versionchange";

    idbModules.IDBTransaction = IDBTransaction;
}(idbModules));
