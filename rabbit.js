/*
ISC License

Copyright (c) 2017, Scott Larkin

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
*/



(_ => {
    'use strict';

    const amqp = require('amqplib/callback_api'),
        onDeath = require('death'),
        { Readable, Writable } = require('stream'),

        //String constants
        STREAM_QUEUE_PREFIX = 'rabbit_rpc_dataQueue_',
        ERROR_CAN_NOT_ASSERT_QUEUE = 'Couldn\'t assert queue',
        ERROR_RPC_FAIL = 'Error executing Rabbbit RPC function.',
        ERROR_NO_CALLBACK = 'Final parameter to rpcRequest must be a callback function.',
        ERROR_IN_CALLBACK = 'Error executing callback',
        ERROR_CAN_NOT_ASSERT_EXCAHNGE = 'Could not assert exchange',
        ERROR_IN_BROADCAST_ACTION = 'Error in broadcast action',
        ERROR = 'ERROR';


    function generateUuid() {
        return Math.random().toString() +
            Math.random().toString() +
            Math.random().toString();
    }

    function toRaw(obj) {
        let o = JSON.parse(obj);

        if (o instanceof Array) {
            o = o.map(e => {
                if (typeof e === 'object' && e && e.type === 'Buffer')
                    return new Buffer(e);

                return e;
            });
        }

        return o;
    }

    function toTransport(message) {
        return JSON.stringify(message);
    }

    function connect(addr, cb) {

        typeof addr === "function" && (cb = addr, addr = null);

        amqp.connect(addr || 'amqp://localhost', (err, conn) => {

            if (!err)
                return conn.createChannel((err, ch) => {
                    cb(err, conn, ch);
                });

            cb(err, null);
        });
    }

    function disconnect(conn, callback) {

        callback || (callback = () => { });

        if (!conn)
            return callback();

        setTimeout(function () {
            conn.close();
            callback();
        }, 500);
    }

    let connections = {};
    let pendingRequests = Symbol();
    let connection = Symbol();
    let channel = Symbol();
    let conHost = Symbol();
    let request = Symbol();
    let instances = {};

    function getConnection(host) {
        if (connections[host])
            return connections[host];
    }

    function setConnection(host, conn, ch) {
        connections[host].connection = conn;
        connections[host].channel = ch;
    }

    onDeath(() => {
        Object.keys(connections).forEach(host => {
            let instances = connections[host].instances;
            instances.length && instances[0].close();
        });
    });

    let getQueue = (broker, id, callback) => {

        broker[request](() => {
            broker[channel].assertQueue(`${STREAM_QUEUE_PREFIX}${id}`, {}, (err, q) => {

                if (err) {
                    throw new Error(ERROR_CAN_NOT_ASSERT_QUEUE);
                }

                callback(err, q);
            });
        });

    };

    class ReadStream extends Readable {

        constructor(id, broker, options) {

            super(options);

            this.id = id;
            this.broker = broker;

            this.on('end', () => {
                this.broker[channel].deleteQueue(`${STREAM_QUEUE_PREFIX}${this.id}`)
            });

            getQueue(this.broker, this.id, (err, q) => {

                this.broker[channel].consume(q.queue, msg => {

                    if (!msg) return;

                    let content = toRaw(msg.content.toString());

                    //content will be null if the stream has finished reading
                    if (!content) {
                        this.broker[channel].ack(msg);
                        return this.push(null); //end the stream
                    }

                    this.unshift(new Buffer(content));
                    this.broker[channel].ack(msg);
                });
            });
        }

        _read(size) {

        }

    };

    class WriteStream extends Writable {
        constructor(id, broker, options) {

            super(options);
            this.id = id;
            this.broker = broker;
        }

        _write(chunk, encoding, callback) {

            getQueue(this.broker, this.id, (err, q) => {

                this.broker[channel].sendToQueue(q.queue, Buffer.from(toTransport(chunk)));

                //tell the paired stream to this si the final chunk
                if (this._writableState.ending) {
                    this.broker[channel].sendToQueue(q.queue, Buffer.from(toTransport(null)));
                }

                callback();
            });
        }
    };

    class Broker {

        constructor(host) {

            this[conHost] = host;
            this[pendingRequests] = [];

            let connObj = getConnection(host);

            if (connObj) {
                if (connObj.connecting) {
                    connObj.instances.push(this);
                }
                else {
                    this[connection] = connObj.connection;
                    this[channel] = connObj.channel;
                }
            }
            else {

                let onError = e => {

                    if (!connections[host].disconnect) {

                        console.error(ERROR);
                        console.error(e);

                        connections[host].instances.forEach(instance => {
                            instance[connection] = null;
                            instance[channel] = null;
                        });

                        setTimeout(() => {
                            fun(true);
                        }, 500);
                    }

                };

                let fun = (recon) => {

                    connections[host].connecting = true;

                    connect(host, (err, conn, ch) => {

                        if (err)
                            throw new Error(err);

                        if (recon) {
                            connections[host].disconnect = true;
                            connections[host].channel.close();
                            connections[host].connection.close();
                        }

                        connections[host].connecting = false;

                        connections[host].instances.forEach(instance => {
                            instance[connection] = conn;
                            instance[channel] = ch;
                            instance[pendingRequests].forEach(r => r());

                            if (!recon)
                                instance[pendingRequests] = [];
                        });

                        setConnection(host, conn, ch);

                        //handle unexcpected dosconnects
                        conn.on('error', onError);
                        ch.on('error', onError);
                        ch.on('close', onError);

                        let dataStreams = {};

                    });
                };

                connections[host] = {};
                connections[host].instances = [this];

                fun(false);
            }

            this[request] = req => {
                if (this[channel])
                    return req();

                this[pendingRequests].push(req);
            };

        }

        createWriteStream(id, options, callback) {

            return new WriteStream(id, this, options);
        }

        createReadStream(id, options, callback) {

            return new ReadStream(id, this, options);
        }

        close() {
            //flag intentional disconnect
            connections[this[conHost]].disconnect = true;
            disconnect(this[connection].connection);
        }

        rpcResponse(queue, action) {

            this[request](() => {
                this[channel].assertQueue(queue, { durable: false }, (err, q) => {

                    if (err) {
                        this[channel].emit('error', ERROR_CAN_NOT_ASSERT_QUEUE);
                    }

                    this[channel].consume(queue, msg => {

                        try {
                            action(...toRaw(msg.content.toString()), (err, resp) => {

                                let response = {
                                    error: err,
                                    response: resp
                                };

                                this[channel].sendToQueue(msg.properties.replyTo, Buffer.from(toTransport(response)), { correlationId: msg.properties.correlationId });
                                this[channel].ack(msg);
                            });
                        }
                        catch (caught) {
                            console.error(ERROR_RPC_FAIL);
                            console.error(caught);
                            this[channel].sendToQueue(msg.properties.replyTo, Buffer.from(toTransport({ error: 'action failed', response: caught })), { correlationId: msg.properties.correlationId });
                            this[channel].ack(msg);
                        }
                    });
                });
            });
        }

        rpcRequest(/*queue, arg1, arg2, ...argn, callback*/) {

            this[request](() => {

                let args = [...arguments];

                let queue = args[0];
                let parameters = args.slice(1, args.length - 1);
                let callback = args.pop();
                let rabbitChannel = this[channel];

                if (typeof callback !== 'function') {
                    return console.error(ERROR_NO_CALLBACK);
                }

                let corr = generateUuid();

                rabbitChannel.assertQueue('', { noack: true, durable: false, exclusive: true, 'auto-delete': true }, (err, q) => {

                    rabbitChannel.consume(q.queue, function (msg) {
                        if (!msg) return;

                        if (msg.properties.correlationId === corr) {

                            try {
                                let message = toRaw(msg.content.toString());

                                callback(message.error, message.response);
                            }
                            catch (err) {
                                console.error(ERROR_IN_CALLBACK, err);
                            }

                            rabbitChannel.deleteQueue(q.queue);
                        }
                    });

                    rabbitChannel.sendToQueue(queue, Buffer.from(toTransport(parameters)), { correlationId: corr, replyTo: q.queue });
                });
            });
        }

        //curry the rpc request slightly. Will abstract the fact that this is a amqp call a bit and seem like you are callign any old js function

        /*
            let addNumbers = rpcRequestWithName('addNumbers');

            addNumbers(1,2,3,4,5, (error, result) => console.log(result));
        */
        rpcRequestWithName(queue) {
            let that = this;
            return function () {
                that.rpcRequest(queue, ...arguments);
            }
        }

        //send a message to all clients listening for an event
        broadcast(event, message, callback) {
            this[request](() => {

                let rabbitChannel = this[channel];

                rabbitChannel.assertExchange(event, 'fanout', {}, (err, exchange) => {

                    if (err)
                        return callback(err);

                    try {
                        rabbitChannel.publish(event, '', Buffer.from(toTransport(message)));

                        callback();
                    }
                    catch (er) {
                        callback(er);
                    }
                });

            });
        }

        //listen for broadcasted events and do soemthing when an event is detected
        listen(event, action, callback) {

            callback = callback || (() => { });

            this[request](() => {

                let rabbitChannel = this[channel];

                rabbitChannel.assertExchange(event, 'fanout', {}, (err, exchange) => {

                    if (err) {
                        console.error(`${ERROR_CAN_NOT_ASSERT_EXCAHNGE} - ${event}`);
                        return callback(err);
                    }

                    let id = generateUuid();

                    rabbitChannel.assertQueue(`${event}_${id}`, { noack: true, durable: false, exclusive: true }, (err, queue) => {

                        if (err) {
                            console.error(`${ERROR_CAN_NOT_ASSERT_QUEUE} - ${event}_${id}`);
                            return callback(err);
                        }

                        rabbitChannel.bindQueue(`${event}_${id}`, event, '', {}, (err) => {
                            if (err) {
                                console.error(`Could not bind queue ${event}_${id} to exchange ${event}`);
                                return callback(err);
                            }

                            rabbitChannel.consume(`${event}_${id}`, function (msg) {

                                rabbitChannel.ack(msg);

                                try {
                                    action(toRaw(msg.content));
                                }
                                catch (ex) {
                                    console.error(ERROR_IN_BROADCAST_ACTION);
                                }

                            });

                            callback(null, `listening for ${event}`);

                        });
                    });
                });
            });
        }

    }

    module.exports = Broker;

})();

