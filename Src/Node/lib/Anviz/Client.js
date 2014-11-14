/**
 * @author Ben Periton <dev@ben.periton.co.uk>
 *
 * Connect to the A300 and run various commands to get/set data on the device.
 */

// ----- Header
// -----------------------------------------------------------------------------

var
	// External dependencies
	util = require('util'),
	events = require('events'),
	util = require('util'),
	net = require('net'),
	_ = require('underscore'),
	sleep = require('sleep'),
	// Internal dependencies
	crc16 = require('./crc'),
	pack = require('../pack')
;

// Lets use events
util.inherits( Client, events.EventEmitter );


// ----- Helpers
// -----------------------------------------------------------------------------

/* 
 * getDate (timestamp):
 * @timestamp: seconds elapsed since 2000-01-01 00:00
 * returns: Date object 
*/
function getDate (timestamp) { 
	var _timestamp = timestamp * 1000; // convert to miliseconds
	var base = Date.UTC(2000, 00, 02);
	return new Date(base + _timestamp);

}  // getDate


/**
 * 
 */
function padHex (d, padding) {
	var
		hex = Number(d).toString(16)
	;

	padding = padding || 2;

	while ( hex.length < padding ) {
		hex = '0' + hex;
	}

	return hex;
}

/**
 * 
 */
function buildRequest (deviceId, cmd, data) {
	var
		self = this,
		len = 0,
		rawRequest = 'A5', // Always starts with this
		blob
	;

	if ( deviceId < 0 || deviceId > 99999999 ) {
		throw new RangeError( 'Invalid device id. 1 - 99999999' );
	}

	data = data || '';

	// Build up the request
	rawRequest += padHex( deviceId, 8 ) + cmd;

	// Length of data - could be 0
	rawRequest += padHex( data.length / 2, 4 );

	// Add on any data
	if ( data ) {
		rawRequest += data;
	}
	// Add on checksum
	rawRequest += crc16( pack('H*', rawRequest) );
	// Create actual request
	return new Buffer( rawRequest, 'hex' );
}



// ----- Client class
// -----------------------------------------------------------------------------

/**
 * 
 */
function Client (host, port, deviceId) {
	var
		self = this
	;
	this.intervals = {};

	events.EventEmitter.call( this );

	this.debug = true;
	this.host = host;
	this.port = port;
	this.deviceId = deviceId;

	this.listeners = [];

	this.isGettingStaffInfo = false;

	this.ret = {
		'00': 'ACK_SUCCESS',
		'01': 'ACK_FAIL',
		'04': 'ACK_FULL',
		'05': 'ACK_EMPTY',
		'06': 'ACK_NO_USER',
		'08': 'ACK_TIME_OUT',
		'0A': 'ACK_USER_OCCUPIED',
		'0B': 'ACK_FINGER_OCCUPIED'
	};

	this.socket = net.connect({
		host: this.host,
		port: this.port

	}).on('connect', function () {
		if (self.debug) {
			console.log('Connection established.');
		}
		self.emit('connect');

	}).on('error', function (err) {
		if (self.debug) {
			console.log('Error occured: ' + err);
		}
		self.emit('error', err);
	}).on('data', function(data, seq) {
		var response = self.parseResponse(data);

		self.emit('data', response, self.seq);
	});

	this.socket.setNoDelay(false);
}

/**
 * Parser for response
 */
Client.prototype.parseResponse = function parseResponse (data) {
	if (data == '') {
		return;
	}

	var response = {  // stored as hex
		stx: 'A5',
		device_code: '', // 4 bytes
		response_code: '',  // 1 byte (command + 0x80)
		command: '',
		ret: '', // 1 byte
		len: '', // 2 bytes
		data: '', // 0-400 bytes - buffer
		crc16: '' // 2 bytes
	}

	var cur = 0;

	response.stx = padHex(data[cur++], 2);
	response.device_code = padHex(data[cur++], 2) + padHex(data[cur++],2) + padHex(data[cur++],2) + padHex(data[cur++],2);
	response.response_code = data[cur++];
	response.command = padHex(response.response_code - 0x80, 2);
	response.ret = padHex(data[cur++], 2); // 
	response.len = padHex(data[cur++], 2) + padHex(data[cur++], 2);
	response.data = new Buffer(parseInt(response.len, 16));
	for (var i = 0; i < parseInt(response.len, 16); i++) {
		response.data[i] = data[cur++];
	}
	response.crc16 = padHex(data[cur++], 2) + padHex(data[cur++], 2);

	return response;
} // parseResponse

/**
 * 
 */
Client.prototype.disconnect = function disconnect () {
	this.socket.end();
}

/**
 * Raw:  A5 00 00 00 01 32 00 00
 * CRC:  52 B9
 * Req:  A5 00 00 00 01 32 00 00 52 B9
 * Res:  A5 00 00 00 01 B2 00 00 0F 01 80 00 01 01 01 00 05 00 00 64 00 00 05 00 3A A7
 *
 * Firmware		1-8		(Firmware version is ASC)
 * 9-11
 * Sleeptime	12		(0-250 minutes, never sleep when set as 0)
 * Volume		13		(Level 0-5, mute if set as 0)
 * Language		14		(0-simplified Chinese, 1-Traditional Chinese, 2-English, 3-French, 4-Spanish, 5-Portuguese)
 * 15
 * 16
 * 17
 * 18
 */

/**
 * Clear user records
 */
Client.prototype.clearRecords = function(callback) {
	var self = this;

	var command = '4d';
	request = buildRequest( this.deviceId, command);

	// setup parser for the data
	this.socket.once('data', function(data) {
		var response = self.parseResponse(data);

		if (response.command == command) { // this is for our response
			return callback(response);
		}
	});
	if (this.debug) { 
		console.log(request);
	}
	this.socket.write(request);


} // clearRecords


 /**
  * Get Record Information
  */

Client.prototype.getRecordInformation = function(callback) {

	var self = this;

	var command = '3c';

	request = buildRequest( this.deviceId, command);

	this.listeners['getRecordInformation'] = function(data) {
		var response = self.parseResponse(data);
		var recInfo = {
			user_amount: 0,
			fp_amount: 0,
			password_amount: 0,
			card_amount: 0,
			all_record_amount: 0,
			new_record_amount: 0
		};

		if (response.command == command) { // this is for our response
			var cur = 0;
			recInfo.user_amount = parseInt(padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2), 16);
			recInfo.fp_amount = parseInt(padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2), 16);
			recInfo.password_amount = parseInt(padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2), 16);
			recInfo.card_amount = parseInt(padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2), 16);
			recInfo.all_record_amount = parseInt(padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2), 16);
			recInfo.new_record_amount = parseInt(padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2) + padHex(response.data[cur++], 2), 16);

			return callback(recInfo);
		}
	};
	
	// setup parser for the data
	this.socket.once('data', this.listeners['getRecordInformation']);
	if (this.debug) { 
		console.log('Request: ' + request.toString('hex'));
	}
	this.socket.write(request);

}; // getRecordInformation

Client.prototype.uploadStaffInfo = function(staffArr, callback) {

	var i,j,staffObjArr,chunk = 12;

	var self = this;

	var command = '43';

	var _response = '';

	this.socket.on('data', function(data) {
		var response = self.parseResponse(data);

		if (response.command == command) { // this is for our response

			clearInterval(self.intervals[command].shift());
			_response += response.data.readUInt16LE(0).toString(2) + '\n';

			if (self.intervals[command].length == 0) {
				return callback(_response);
			}
		}
	});
	this.intervals[command] = [];
	requests = [];
	
	for (i=0, j=staffArr.length; i < j; i+=chunk) {

		(function () { 

			var scnt = 0;
			var request;
			staffObjArr = staffArr.slice(i, i + chunk);
			var data = Buffer(1 + staffObjArr.length * 27);

			data[0] = staffObjArr.length;

			_.each(staffObjArr, function(staff) {
				cur = 1 + scnt * 27;

				var user_code = padHex(staff.user_code, 10);
				for (var i = 0; i < 5; i++) {
					data.writeUInt8(parseInt('0x' + user_code.substring(i*2, i*2+2)), cur++);
				}
				data[cur++] = 0xFF;
				data[cur++] = 0xFF;
				data[cur++] = 0xFF; // NUmber of pwd 3 bytes
				data[cur++] = 0xFF;
				data[cur++] = 0xFF;
				data[cur++] = 0xFF; // Card code no card code
				for (var i = 0; i < 10; i++) {
					data[cur++] = parseInt('0x'+staff.name.charCodeAt (i).toString(16));
				} // name 10 byte
				data[cur++] = parseInt('0x' + staff.department.toString(16));
				data[cur++] = parseInt('0x' + staff.group_no.toString(16));
				data[cur++] = parseInt('0x' + 'FF');//staff.attendance_mode.toString(16));
				data[cur++] = 0xFF;
				data[cur++] = 0xFF; // 2 bytes registered FP
				data[cur++] = 0x01;
				scnt++;
			});


			var request = buildRequest( self.deviceId, command, data.toString('hex'));
			if (self.debug) { 
				console.log(request);
			}

			requests.push(request);

			self.intervals[command].push(setInterval(function() { self.socket.write(request); }, (1 + (i/chunk)) * 3000));

		})();
	} // for
} // uploadStaffInfo

Client.prototype.getStaffInfo = function(amount, callback) {
	var self = this;

	var command = '42'; // Download staff info CMD: 0x20
	var chunk = 12; // 12 records at once

	this.intervals[command] = [];

	var listProc = function(data) {
		var response = self.parseResponse(data);
		if (response.command == command) { // Download staff info
			clearInterval(self.intervals[command].shift());

			var cur = 0;
			var validRecords = response.data[cur++];
			var data = response.data;
			for (var i=0; i < validRecords; i++) {
				cur = 1 + i * 27;
				var record = {
					user_code: '',
					number_of_pwd: 0,
					card_code: '',
					name: '',
					department: 0,
					group_no: 0,
					attendance_mode: 0,
					registered_fp: 0,
					special_info: 0
				};
				if (cur+26 <= data.length) {
					var buf = new Buffer(5);
					data.copy(buf, 0, cur, cur+5);
					cur += 5;
					record.user_code = parseInt(buf.toString('hex'), 16);;
					record.number_of_pwd = parseInt(data[cur++], 16) >> 4; // 3 bytes
					record.pwd = data[cur++].toString(16) + data[cur++].toString(16);
					record.card_code = parseInt(data[cur++].toString(16) + data[cur++].toString(16) + data[cur++].toString(16), 16);  // 3 bytes
					record.name = String.fromCharCode(data[cur++]) + String.fromCharCode(data[cur++]) + String.fromCharCode(data[cur++]) + String.fromCharCode(data[cur++]) + String.fromCharCode(data[cur++]) + String.fromCharCode(data[cur++]) + String.fromCharCode(data[cur++]) + String.fromCharCode(data[cur++]) + String.fromCharCode(data[cur++]) + String.fromCharCode(data[cur++]); // 10 bytes
					record.department = data[cur++];
					record.group_no = data[cur++];
					record.attendance_mode = data[cur++];
					record.registered_fp = data[cur++] + data[cur++];
					record.special_info = data[cur++];
					staffList.push(record);
				}
			}

			if (validRecords < chunk) {
				console.log('end of batch');
				return callback(staffList, listProc);
			} else {
				console.log(self.intervals[command].length + ' batch sent');
				// callback(staffList, false);
			}

		} // if response
	};

	this.socket.on('data', listProc);

	var staffList = [];

	var seq = Array.apply(0, Array(Math.ceil(amount/chunk))).map(function() { return 1; });

	seq.forEach(function(item, index) {
			var request;
			var pending = 0;
			if (amount > chunk) pending = chunk;

			if (amount <= chunk) pending = amount;

			if (index == 0) {
				request = buildRequest( self.deviceId, command, '01' + padHex(parseInt(pending, 10), 2));
			} else {
				request = buildRequest( self.deviceId, command, '00' + padHex(parseInt(pending, 10), 2));
			}
			amount -= chunk;

			if (self.debug) { 
				console.log(request);
			}

			self.intervals[command].push(setInterval(function() { self.socket.write(request); }, (1 + index) * 2000));
	}); // foreach for sequence of amount

}; // getStaffInfo

Client.prototype.getBasicInfo = function getBasicInfo (callback) {
	var
		request,
		command = '30'
	;

	var self = this;

	this.listeners['getBasicInfo'] = function(data) {
		var response = self.parseResponse(data);
		if (response.command == command) {
			console.log(response.data);
			callback(null, response);
		}
	};

	this.socket.on('data', this.listeners['getBasicInfo']); // on 'data'

	request = buildRequest( this.deviceId, command); //, '01B669' + '05' + '05' + '03' +  '10' + '00' + '00' + '00' );
	if (this.debug) {
		console.log('Request: ' + request.toString('hex'));
	}

	this.socket.write(request);
}; // getBasicInfo

Client.prototype.getExtendedInfo = function getExtendedInfo (callback) {
	var
		request,
		command = '32'
	;

	var self = this;

	this.listeners['getExtendedInfo'] = function(data) {
		var response = self.parseResponse(data);
		if (response.command == command) {
			console.log(response.data);
			callback(null, response);
		}
	};

	this.socket.on('data', this.listeners['getExtendedInfo']); // on 'data'

	request = buildRequest( this.deviceId, command); //, '01B669' + '05' + '05' + '03' +  '10' + '00' + '00' + '00' );
	if (this.debug) {
		console.log('Request: ' + request.toString('hex'));
	}

	this.socket.write(request);
}; // getBasicInfo

Client.prototype.getFPTemplate = function getFPTemplate(userCode, fpNum, callback) {
	var request,
		command = '44';

	var self = this;


	this.intervals[command] = [];
	var listenerProc = function(data, userCode) {
		var response = self.parseResponse(data);
		if (response.command == command) {
			clearInterval(self.intervals[command].shift());
			return callback(null, response);
		}
	};

	if (this.listeners['getFPTemplate'] == undefined) {
		this.socket.on('data', listenerProc); // on 'data'
		this.listeners['getFPTemplate'] = listenerProc;
	} else {
		this.socket.removeListener('data', this.listeners['getFPTemplate']);
		this.socket.on('data', listenerProc);
		this.listeners['getFPTemplate'] = listenerProc;
	}
	
	if (fpNum !== 1 && fpNum !== 2) {
		return callback(new Error('Fp number can only be 1 or 2'));
	}

	var buf = new Buffer(6);
	buf.writeUInt8(fpNum, 5);
	buf.writeUInt16BE(userCode, 3);
	buf.writeUInt16BE(0, 1);
	buf.writeUInt8(0, 0);

	request = buildRequest( this.deviceId, command, buf.toString('hex'));
	if (this.debug) {
		console.log(request);
	}

	self.intervals[command].push(setInterval(function() { self.socket.write(request); }, self.intervals[command].length  * 3000))
}; // getFPTemplate

Client.prototype.getPhotoAmount = function getPhotoAmount (callback) {
	var request,
		command = '2a';

	var self = this;

	var listenerProc = function(data) {
		var response = self.parseResponse(data);
		if (response.command == command) {
			return callback(null, response);
		}
	};
	
	self.listeners['getPhotoAmount'] = listenerProc;

	self.socket.on('data', listenerProc);

	request = buildRequest( this.deviceId, command);

	if (this.debug) {
		console.log(request);
	}

	self.socket.write(request);
} // getPhotoAmount

Client.prototype.getPhotoHead = function getPhotoHead (callback) {
	var request,
		command = '2b';

	var self = this;

	var listenerProc = function(data) {
		var response = self.parseResponse(data);

		if (response.command == command) {
			return callback(null, response);
		}
	};

	self.listeners['getPhotoHead'] = listenerProc;

	self.socket.on('data', listenerProc);


	var req = new Buffer(2); // two bytes

	req.writeUInt8(0x01, 0);
	req.writeUInt8(50, 1);


	request = buildRequest (this.deviceId, command, req.toString('hex'));

	if (this.debug) {
		console.log(request);
	}

	self.socket.write(request);


} // getPhotoHead

/**
 * Raw:  A5 00 00 00 01 38 00 00
 * CRC:  28 CA
 * Req:  A5 00 00 00 01 38 00 00 28 CA
 * Res:  A5 00 00 00 01 B8 00 00 06 0E 07 0F 0C 10 1C 71 38
 *
 * Year		1
 * Month	2
 * Day		3
 * Hour		4
 * Minute	5
 * Second	6
 */
Client.prototype.getDatetime = function getDateTime (callback) {
	var
		request
	;

	request = buildRequest( this.deviceId, 38 );
	console.log(request);
};

/**
 * Raw:  A5 00 00 00 01 40 00 02 00 19
 * CRC:  8E F3
 * Req:  A5 00 00 00 01 40 00 02 00 19 8E F3
 * Res:  A5 00 00 00 01 C0 01 00 00 AF 65
 */
Client.prototype.getStaffAttendance = function getStaffAttendance (amount, callback) {
	var self = this;

		var command = '40'; // Download T&A
		var chunk = 25; // 25 records at once

		this.intervals[command] = [];

		var attnList = [];

		var listProc = function(data) {
			var response = self.parseResponse(data);
			if (response.command == command) { // Download staff info
				clearInterval(self.intervals[command].shift());

				var cur = 0;
				var validRecords = response.data[cur++];
				var data = response.data;
				for (var i=0; i < validRecords; i++) {
					cur = 1 + i * 14;

					var recBuf = new Buffer(14); // 14 bytes each record
					var record = {
						user_code: '',
						date_and_time: 0,
						backup_code: 0,
						record_type: 0,
						work_types: 0,
					};
					if (cur+13 <= data.length) {
						record.user_code = parseInt(data.slice(cur, cur+5).toString('hex'), 16);cur += 5;
						record.date_and_time = getDate(parseInt(data.slice(cur, cur+4).toString('hex'), 16)); cur += 4; // 3 bytes
						record.backup_code = parseInt(data.slice(cur, cur+1).toString('hex'), 16); cur += 1;
						record.record_type = parseInt(data.slice(cur, cur+1).toString('hex'), 16); cur += 1;
						record.work_type = parseInt(data.slice(cur, cur+1).toString('hex'), 16); cur += 3;
						attnList.push(record);
					}
				}

				if (validRecords < chunk) {
					console.log('end of batch');
					console.log(attnList.length);
					return callback(attnList, listProc);
				} else {
					console.log(self.intervals[command].length + ' batch sent');
					// callback(staffList, false);
				}

			} // if response
		};

		this.socket.on('data', listProc);

		var staffList = [];

		var seq = Array.apply(0, Array(Math.ceil(amount/chunk))).map(function() { return 1; });

		seq.forEach(function(item, index) {
				var request;
				var pending = 0;
				if (amount > chunk) pending = chunk;

				if (amount <= chunk) pending = amount;
				if (index == 0) {
					request = buildRequest( self.deviceId, command, '02' + padHex(parseInt(pending, 10), 2));
				} else {
					request = buildRequest( self.deviceId, command, '00' + padHex(parseInt(pending, 10), 2));
				}
				amount -= chunk;

				if (self.debug) { 
					console.log(request);
				}
				self.intervals[command].push(setInterval(function() { self.socket.write(request); }, (1 + index) * 1000));
		}); // foreach for sequence of amount
}; // getStaffAttendance

Client.prototype.clearNewRecords = function clearNewRecords (amount, type, callback) {
	var self = this;

	var command = '4e'; // Download T&A
	var chunk = 25; // 25 records at once

	if (type == null) {
		type = '02';
	}

	var listenerProc = function(data) {
		var response = self.parseResponse(data);
		if (response.command == command) { // Download staff info
			callback(null, response);
		}
	}; // listenerProc

	self.listeners['clearNewRecords'] = listenerProc;

	self.socket.on('data', listenerProc);

	request = buildRequest( self.deviceId, command, type, padHex(parseInt(amount, 10), 6));

	if (self.debug) {
		console.log(request);
	}

	self.socket.write(request);
}; // clearNewRecords

// ----- Expose Module
// -----------------------------------------------------------------------------

module.exports = Client;
