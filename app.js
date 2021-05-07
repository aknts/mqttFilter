process.title = 'filter';
// Initialization 
// Config
const config = JSON.parse(Buffer.from(require('./config.js'), 'base64').toString());

// Settings
var broker = config.globalsettings.broker;
var logtopic = config.mynodeid+'/log';
var controltopic = config.mynodeid+'/control';
var datatopic = config.mynodeid+'/data';
var nextnode = config.nextnode;
var nextnodedatatopic = config.nextnode+'/data';
var previousnodecontroltopic = config.previousnode+'/control';
var pipelinetopic = config.globalsettings.nameid+'/broadcast'
var mynodeid = config.mynodeid;
var rate_transmit = config.appsettings.rate_transmit;
var rate_sampling = config.appsettings.rate_sampling;

// Modules
const mqttmod = require('mqttmod');
const l = require('mqttlogger')(broker, logtopic, mqttmod, 1);
const filter = require('./filter');

// Variables
var readyresponse = '{"node":"'+mynodeid+'","name":"'+process.title+'","request":"ready"}';
var terminatingresponse = '{"node":"'+mynodeid+'","name":"'+process.title+'","request":"terminating"}';
var init = 0;
var halt = 1;
var appmodules = ['emitter','filter','loadbalancer','trilaterator','aggregator'];
var livemodules = [];
var orderedMeasurements = [];

// Functions
function filterRequests(payload){
	try {
		data = JSON.parse(payload);
    } catch (e) {
        l.error('Received not valid JSON.\r\n'+payload);
		return false;
    }
	var requestingNode = data.node;
	var requestingNodeName = data.name;
	if (requestingNode != mynodeid) {
		switch(data.request) {
			case 'ready':
				if (livemodules.length < appmodules.length) {
					var alpha = -1;
					var beta = 0
					for(var i = 0; i < appmodules.length; i++){
						alpha = appmodules.indexOf(requestingNodeName);
						if (alpha > -1) {
							for(var ii = 0; ii < livemodules.length; ii++){
								if (livemodules[ii].name == requestingNodeName) {
									beta = 1;
								}
							}
						}
					}
					if (alpha > -1 && beta == 0) {
						if (requestingNodeName == 'trilaterator') {
							livemodules.push({"node":requestingNode,"pid":data.pid,"name":requestingNodeName});
							mqttmod.send(broker,requestingNode+'/'+data.pid+'/control',readyresponse);
						} else {
							livemodules.push({"node":requestingNode,"name":requestingNodeName});
							mqttmod.send(broker,requestingNode+'/control',readyresponse);
						}
						l.info('Node '+requestingNode+' reported that is ready');
						mqttmod.send(broker,requestingNode+'/control',readyresponse);
						l.info('Informing the new nodes that local node is ready');
						console.log(livemodules);
					} 
					if (alpha > -1 && beta == 1) {
						l.info('A '+requestingNodeName+' node already exists');
					}
					if (alpha == -1) {
						l.info(requestingNodeName+' node is not valid');
					}
				}
				if (livemodules.length == appmodules.length) {
					if (init == 0 && halt == 1) {
						halt = 0;
						l.info('All modules ready');
					}
					if (init == 1 && halt == 1){
						halt = 2;
						l.info('All modules ready');
					}
					if (requestingNodeName == 'trilaterator' && init == 1 && halt == 0) {
						for(var i = 0; i < livemodules.length; i++){
								if (livemodules[i].name == requestingNodeName && livemodules[i].node == requestingNode && livemodules[i].pid != data.pid) {
									mqttmod.send(broker,requestingNode+'/'+data.pid+'/control',readyresponse);
								}	
						}
					}
				}
			break;
			case 'execute':
				if (init == 0 && halt == 0) {
					mqttmod.send(broker,previousnodecontroltopic,payload);
					init = 1;
					l.info('Starting application');
				} else if (init == 1 && halt == 2) {
					mqttmod.send(broker,previousnodecontroltopic,payload);
					halt = 0;
					l.info('Restarting application');
				} else {
					l.info('Not all modules are loaded');
				}
			break;
			case 'terminating':
				for(var i = 0;i < livemodules.length;i++){ 
					if (livemodules[i].name == requestingNodeName && livemodules[i].node == requestingNode) { 
						switch(requestingNodeName) {
							case 'trilaterator':
								if ( data.pid == livemodules[i].pid) {
									livemodules.splice(i,1);
								}
							break;
							default:
								livemodules.splice(i,1);
						}
						console.log('livemodules');
						console.log(livemodules);
					}
				}
				if (livemodules.length < appmodules.length) {
					l.info('Node '+requestingNode+' reported that is terminating, halt application.');
					halt = 1;
				}
			break;
			default:
				l.info('Didn\'t receive a valid request');
		}
	}
}


function filterResults(payload) {
	if (halt == 0) {
		heapCheck();
		var results = JSON.parse(payload);
		l.info('Filtering '+results.length+' results.');
		Array.prototype.push.apply(orderedMeasurements,filter.order(results,l));
		l.debug('Ended up with ' + orderedMeasurements.length + ' ordered measurements.');
		let data = orderedMeasurements.splice(0,orderedMeasurements.length);
		sendData(data);
	}
}

function sendData (results) {
	l.info('Sending data, array of '+JSON.stringify(results.length)+' results to '+nextnodedatatopic+'.');
	mqttmod.send(broker,nextnodedatatopic,JSON.stringify(results));
}

function heapCheck () {
	var usage = '';
	const used = process.memoryUsage();
	for (let key in used) {
		usage = usage.concat(`${key} ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB, `);
		if (key == 'external') {
			usage=usage.slice(0, -2);
			l.info('Heap usage: '+usage);
		}
	}
}

// Begin execution
livemodules.push({"node":mynodeid,"name":process.title});

// Start recieving control MQTT messages
l.info('Started recieving control MQTT messages on '+controltopic);
mqttmod.receive(broker,controltopic,filterRequests);	

// Start recieving data MQTT messages
l.info('Started recieving data MQTT messages on '+datatopic);
mqttmod.receive(broker,datatopic,filterResults);

// Start recieving control MQTT messages
l.info('Started receiving control messages on '+pipelinetopic);
mqttmod.receive(broker,pipelinetopic,filterRequests);

mqttmod.send(broker,pipelinetopic,readyresponse);

// Inform previous node that you are ready
//mqttmod.send(broker,previousnodecontroltopic,readyresponse);

process.on('SIGTERM', function onSigterm () {
	l.info('Got SIGTERM');
	mqttmod.send(broker,pipelinetopic,terminatingresponse);
});

process.on('SIGINT', function onSigterm () {
	l.info('Got SIGINT');
	mqttmod.send(broker,pipelinetopic,terminatingresponse);
});

process.on('SIGKILL', function onSigterm () {
	l.info('Got SIGKILL');
	mqttmod.send(broker,pipelinetopic,terminatingresponse);
});

process.on('SIGHUP', function onSigterm () {
	l.info('Got SIGHUP');
	mqttmod.send(broker,pipelinetopic,terminatingresponse);
});