
#rabbt_rpc  

Node module wrapping the amqplib library.  

Make it easy to build a distributed microservice architecture.  

Requires Nodejs & rabbitmq  

Useage examples:  

### Remote Process Call
#### Server:  

```javascript

let Rabbit = require('rabbit_rpc');
let broker = new Rabbit(); //no args = connect to amqp://localhost

broker.rpcResponse('addNumbers', (a, b, c, d, callback) => {

    //simply sum the args
    let sum = a + b + c + d;

    //as per node convention, any error goes as the 1st callback arg
    callback(null, sum);

});

broker.rpcResponse('sumArray', (array, callback) => {

    //simply sum the args
    let sum = array.reduce((a,b)=> a+=b, 0);

    //as per node convention, any error goes as the 1st callback arg
    callback(null, sum);
});
```

#### Client:  

```javascript
let Rabbit = require('rabbit_rpc');
let broker = new Rabbit(); //no args = connect to amqp://localhost

broker.rpcRequest('addNumbers', 1, 2, 3, 4, (err, result) => 
    console.log(result)); //logs 10

broker.rpcRequest('sumArray', [100,200,300,1], (err, result) => 
    console.log(result)); //logs 601

//close connection (optional)
broker.close();
broker = null;
```  

Client and server running as different node processes, optionally on different machines as long as they can both connect to the same rabbitmq server.  

Server processes the request and returns the result to the client.  

Examples above are trivial summing but when you want to offload heavy computation to another process or machine this is very useful.

### Broadcasting and listening for events

Broadcast an event from an application. This event is sent to all listening apps.

#### Broadcaster 

```javascript
let Rabbit = require('rabbit_rpc');
let broker = new Rabbit();

//broadcast an event

broker.broadcast('eventName', 'Event message', error => {
    //callback called when the message has been sent, or there was an error
    //handle an error here;
});
```

#### Listener(s) 

```javascript
let Rabbit = require('rabbit_rpc');
let broker = new Rabbit();

//listen for an event

broker.listen('eventName',

    //action to perform on an event 
    message => console.log(message), //logs 'Event message'
    
    error => {
        //callback called when the rabbit connection is established and the app is listening
        //if the app cannot listen the error parameter will not be null
    }
);
```

Broadcasting and listening is useful when you need to send messages to many apps at once.  

### Streaming  

Stream data in chunks over RabbitMQ using NodeJS streams.  

Useage examples:  

In this example, we'll stream a file from one server and save it on the client.    

####Server
```javascript
const fs = require('fs'),
    Rabbit = require('rabbit_rpc');

let broker = new Rabbit();

function guid() {
    let s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

//Set up an RPC response which will allow the client to request a file stream
broker.rpcResponse('fsStreamRead', (filePath, callback) => {

    //get a uniqie id, this will be used to link a read anda write stream to the same AMQP queue
    let uniqueId = guid();

    //get a file read stream using fs module, passing the path of the file to read
    let fileRead = fs.createReadStream(filePath);

    //call the broker function "createWriteStream", passing a unique id. returns a writable stream.
    let writeStream = broker.createWriteStream(uniqueId, {});

    //pipe the contents of the file to the writableStream from the broker
    fileRead.pipe(writeStream);

    //call the rpc callback
    callback(null, uniqueId);
});
```  
  
####Client
```javascript
const fs = require('fs'),
    Rabbit = require('rabbit_rpc');

let broker = new Rabbit();

//Request a file stream from the server, passing a unique request ID and the path to the file
broker.rpcRequest('fsStreamRead', './img.jpg', (error, uniqueId) => {

    //Note that the path requested is the path to the file on the server machine.

    //create a file write stream with fs module
    //the path below is where the file will be saved on the client machine
    let fileWrite = fs.createWriteStream('./img.jpg');

    //get a readable stream from the broker. pass the unique id returrned from the RPC request.
    let readStream = broker.createReadStream(uniqueId, {})

    readStream.on('end', () => {
        console.log('finished reading file from server');
    });

    //pipe the contents of the returned stream to the file write stream.
    readStream.pipe(fileWrite);
});
```

