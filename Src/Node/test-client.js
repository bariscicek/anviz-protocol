/**
 * @author Baris Cicek <baris@irrawaddytowers.com>
 *
 * Communicate tool to update/backup Anviz O1000.
 */

// ----- Header
// -----------------------------------------------------------------------------

var
	// Internal dependencies
	stream = require('stream'),
	fs = require('fs'),
	AnvizClient = require('./lib/Anviz/Client'),
	util = require('util'),
	async = require('async'),
	moment = require('moment'),
	program = require('commander'),
	openerp = require('openobject'),
	_ = require('underscore'),
	nodecsv = require('node-csv').createParser(),
	Q = require('bluebird'),
	
	// Locals
	anviz
;

var erpConfig = {
	host: '192.168.122.17',
	port: '8069',
	user: '',
	pass: '',
	database: ''
};


var csvFile = './data/employees.csv';

var anviz;

program
.version('0.0.1')
.option('-D, --device <deviceid>', 'Device id')
.option('-H, --host <ip>', 'Ip address of device')
.command('updateall', 'Update all staff')
.command('push <staffid>', 'Push the attendance info for specified staff');

program
	.command('update <staffid>')
	.description('Update specified staff')
	.action(function(staffid) {
		anviz = new AnvizClient( program.host, 5010, program.device );
		anviz.on('connect', function() {
			anviz.getRecordInformation(function(recInfo) {
				// get UserRecords 12 reacords each
				var allStaff = [];
				console.log(recInfo.user_amount + ' records found.');
				anviz.getStaffInfo(recInfo.user_amount, function(staffList) {
					console.log(staffList);
				});
			});
		}); // anviz.on
	}); // action update 
program	
	.command('backup <backupfile>')
	.description('Backup the device')
	.action(function(backupfile) {
		/* Backup file structure:
		 * Part 1: Information about device (0xF111111)
		 * Data: 29 Byte
		 * Part 2: Configuration of the device (0xF22222)
		 * Data: 26 Byte
		 * Part 3: Record Information (0xF33333)
		 * Data A: 3 Byte  user count
		 * Data B: Length(A) * 27 Byte
		 * Part 4: Fingerprint Template (0xF44444)
		 * Data A: Flag 0x0F0A0B01 User Data Starts
		 * Data B: Fingerprint data 338 Byte
		 * Data C: Flag 0x0F0A0B00 User Data Ends
		 * Part 5: Image File (0xF55555)
		 * Data A: Photo Head count 2 Byte
		 * Data B: Flag 0x0F1A1B01 Photo File Starts
		 * Data C: Picture data
		 * Data D: Flag 0x0F1A1B00 Photo File Ends
		 */
		var backup = fs.createWriteStream('./data/' + backupfile, { flag: 'w', encoding: null, mode: 0666});
		var numberOfUsers = 0;
		/* Get Device Info */

		anviz = new AnvizClient( program.host, 5010, program.device );

		anviz.on('connect', function() {
			async.series({
				getBasicInfo: function(callback) {
					anviz.getBasicInfo(function(err, response) {
						var header = new Buffer(3);
						header.writeUInt16BE(0xF111, 0);
						header.writeUInt8(0x11, 2);
						backup.write(header);
						backup.write(response.data);
						anviz.socket.removeListener('data', anviz.listeners['getBasicInfo']);
						callback(null, 'Backup of getBasicInfo completed');
					});
				},
				getExtendedInfo: function(callback) {
					anviz.getExtendedInfo(function(err, response) {
						var header = new Buffer(3);
						header.writeUInt16BE(0xF222, 0);
						header.writeUInt8(0x22, 2);

						backup.write(header);
						backup.write(response.data);
						anviz.socket.removeListener('data', anviz.listeners['getExtendedInfo']);
						callback(null, 'Backup of getExtendedInfo completed');

					});
				},
				getNumberOfUsers: function(callback) {
					anviz.getRecordInformation(function(record) {
						anviz.socket.removeListener('data', anviz.listeners['getRecordInformation']);
						numberOfUsers = record.user_amount;
						callback(null, 'Total records: '  + record.user_amount);
					});
				},
				getFingerPrintTemplate: function(callback) {
					// var users = Array.apply(0, Array(numberOfUsers)).map(function() { return 1 });
					var header = new Buffer(3);
					header.writeUInt16BE(0xF333, 0);
					header.writeUInt8(0x33, 2);
					backup.write(header);
					anviz.getStaffInfo(numberOfUsers, function(staffList, listProc) {
						anviz.socket.removeListener('data', listProc);
						async.mapSeries(staffList, function(staff, cb) {
							var userCode = new Buffer(4);  // user starts with user code and flag
							userCode.writeUInt16BE(0xF1F1, 0);
							userCode.writeUInt16BE(staff.user_code, 2);
							backup.write(userCode);
							var seq = null;

							if (staff.registered_fp === 3) {
								seq = [ 1, 2 ];
							} else if (staff.registered_fp === 1) {
								seq = [ 1 ];
							} else {
								return cb(null, 'No FP registered for user ' + staff.name);
							}

							// get the fps
							async.mapSeries(seq, function(fpNum, cbFP) {
								anviz.getFPTemplate(staff.user_code, fpNum, function(err, ret) {
									if (ret.ret !== '00') {
										console.log(staff);
									}
									backup.write(ret.data);
									return cbFP(null, ret);
								} );

							}, function(err, fpData) {
									var userCode = new Buffer(4);  // user ends with user code and flag
									userCode.writeUInt16BE(0xF0F0, 0);
									userCode.writeUInt16BE(staff.user_code, 2);
									backup.write(userCode);
									return cb(null, fpData);
									// Back up fpData 1 and 2
							});
						}, function(err, results) {
							anviz.socket.removeListener('data', anviz.listeners['getFPTemplate']);
							anviz.listeners['getFPTemplate'] = undefined;
							callback(null, 'getForEachUser ' + results.length);
						});

					});
				}, // getFingerPrintTemplate
				getPhotoAmount: function(callback) {
					anviz.getPhotoAmount(function(err, resp) {
						anviz.socket.removeListener('data', anviz.listeners['getPhotoAmount']);
						return callback(null, 'Total amount of photo: ' + parseInt(resp.data.toString('hex'), 16));
					});
				}, // getImage
				getPhotoHead: function(callback) {
					anviz.getPhotoHead(function(err, resp) {
						anviz.socket.removeListener('data', anviz.listeners['getPhotoHead']);
						return callback(null, 'Photo head count: ' + parseInt(resp.data.toString('hex'), 16));
					});
				}

			}, function(err, results) {
				console.log('Backup completed. Here is the report:');
				console.log(results);
				anviz.disconnect();

			});
		}); // on 'connect'

	}); // action backup

program
	.command('restore <backupfile>')
	.description('Restore the device from backup file')
	.action(function(backupfile) {

	}); // action restore


program
	.command('pushall')
	.description('Push all attendance data to ERP')
	.action(function() {
		anviz = new AnvizClient( program.host, 5010, program.device );		
		var numberOfRecords = 0;
		var onConnectAnviz = function() {
			async.series({
				getNumberOfUsers: function(callback) {
					anviz.getRecordInformation(function(record) {
						anviz.socket.removeListener('data', anviz.listeners['getRecordInformation']);
						numberOfRecords = record.new_record_amount;
						callback(null, 'Total records: '  + record.user_amount);
					});
				},
				getStaffAttendance: function(callback) {
					anviz.getStaffAttendance(numberOfRecords, function(attnList) {
							callback(null, attnList);
					});
				}

			}, function(err, results) {	
				var erp = new OpenObject(erpConfig.database, erpConfig.host, erpConfig.port, erpConfig.user, erpConfig.pass);
				erp.login(erpConfig.user, erpConfig.pass, function(user_id) {
					var _attnList = results.getStaffAttendance;

					// fix multiple fingerprints for sign_in first one is accounted, for sign_out last one.
					var groupedAttnList = _.indexBy(_attnList, 'user_code');

					var attnList = _.map(_.keys(groupedAttnList), function(userList) {
						console.log(groupedAttnList[userList]);
					}); // map

					return;
					async.eachSeries(attnList, function(attn, cbStaff) {
						// res.user_code is also erp EmployeeID
						// fields should be name: date action: sign_in or sign_out action_desc: false, status: normal
						 	
						var erpAttnTime = new Date(attn.date_and_time.getTime() - 3 * 3600 * 1000);
						var attnObj = {
							employee_id: parseInt(attn.user_code),
							name: erpAttnTime.toISOString().replace(/T/, ' ').replace(/\..+/, ''),
							action_desc: false,
							status: 'normal',
							action: 'sign_in'
						};

						if (attn.date_and_time.getUTCHours() > 12) {
							attnObj.action = 'sign_out';
						} 

						erp.createAttendance(user_id, attnObj  , function(err, ret) {
							if (err) {
								console.log(err);
							}
							console.log(attn.user_code + ' ' + attn.date_and_time.toUTCString() + ' imported');
							cbStaff(null);
						});
					}, function(err) {
						// clear new records
						anviz.clearNewRecords(numberOfRecords, null, function(err, resp) {
							anviz.socket.removeListener('data', anviz.listeners['clearNewRecords']);
							if (resp.response_code === 0) {
								console.log('New records have been cleared');
							}
						}); // clearNewRecords
					}); // eachSeries attendances
				}); // erp.login
				console.log('Total %s records', results.getStaffAttendance.length);
				// console.log(results);
			});

		};

		anviz.on('connect', onConnectAnviz);
	}); // action pushall
program.parse(process.argv);


if (program.device == undefined) {
	console.log(new Error('You need to specify deviceid'));
	return;
}

if (program.host == undefined) {
	console.log(new Error('You need to specify host ip'));
	return;
}
	
/*

anviz.on('error', function (err) {
	console.error('Oops: ', err);
});


nodecsv.mapFile(csvFile, onReadCSVFile);

function onReadCSVFile (err, employees) {
	if (err) {
		return console.log(err);
	}

	var staffArr = [];
	employees.forEach(function(item, index) { 
		var user = {};
		user.name = item['Name'].replace(/ /g, ' ').substring(0, 10);
		user.user_code = item['ID'];
		user.department = 1;
		user.group_no = 1;
		staffArr.push(user);
	}); // forEach(employees)

	var staffs = Q.defer();	
///	console.log(staffArr);
	anviz.on('connect', function () {
		var
			info,
			datetime
		;



		// anviz.clearRecords(function(resp) {
	//		console.log('All User Records Cleared');
			//anviz.uploadStaffInfo(staffArr, function(resp) {
			//	console.log(resp);
	//			console.log('asking staff info');
	//			 anviz.getStaffInfo(20, function(resp) {
	//				console.log('getStaffInfo');
	//			 	console.log(resp);
	//			 });
		//	});

		// });

		console.log(staffs.promise);
	});

	anviz.on('data', function(data) {
		console.log(data);
	});
}

*/
