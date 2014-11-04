var fs       = require('fs-extra');
var user     = require('../lib/user');
var index    = require('../lib/index');
var logger   = require('../lib/logger');
var cliUtil  = require('../lib/cli-util');
var sfClient = require('../lib/sf-client');
var path     = require('path');
var glob     = require('glob');
var async    = require('async');
var _        = require('lodash');

function getFiles(globs, cb) {
  var iterator = function(g, cb2) {
    glob(g, {}, cb2);
  };
  async.concat(globs, iterator, function(err, files) {
    if(err) return cb(err);
    if(!files.length) return cb(new Error('no files found'));
    cb(err, _.uniq(files));
  });
}

function createContainer(data, cb) {
  logger.log('creating metadata container')
  var name = (new Date()).getTime();
  sfClient.tooling.createContainer({ name: name, oauth: data.org }, function(err, container) {
    if(err) return cb(err);
    logger.log('metadata container created: ' + container.id);
    cb(null, container.id);
  });
}

function deleteContainer(data, cb) {
  logger.log('deleting metadata container: ' + data.containerId);

  var opts = {
    type: 'MetadataContainer',
    id: data.containerId,
    oauth: data.org
  };

  sfClient.tooling.delete(opts, function(err, resp) {
    if(err) return cb(err);
    cb(null, data);
  });
}

function deployContainer(data, cb) {

  var asyncContainerId;

  var opts = {
    id: data.containerId,
    isCheckOnly: false,
    oauth: data.org
  }

  function logStatus(status) {
    logger.log('=> deploy status: ' + status);
  }

  function poll() {

    var pollOpts = {
      id: asyncContainerId,
      oauth: opts.oauth
    };

    sfClient.tooling.getContainerDeployStatus(pollOpts, function(err, resp) {

      if(err) return cb(err, resp);

      logStatus(resp.State);

      if(resp.State === 'Completed') {
        logger.log('deployment successful');
        return cb(null, data);
      } else if(resp.State === 'Failed') {
        logger.error('CompilerErrors');
        var cerrs = JSON.parse(resp.CompilerErrors);
        _.each(cerrs, function(e) {
          logger.error('=> ' + e.extent[0] + ': ' + e.name[0]);
          logger.error('    Line ' + e.line[0] + ' - ' + e.problem[0]);
        });
        cb(new Error('Compiler Errors'))
      } else if(resp.State === 'Errored') {
        logger.error('Compile error:');
        logger.error(res.ErrorMsg);
        cb(new Error(res.ErrorMsg));
      } else {
        setTimeout(function() {
          poll();
        }, 1000);
      }
    });
  }

  sfClient.tooling.deployContainer(opts, function(err, asyncContainer) {
    logger.log('Deploying...');
    asyncContainerId = asyncContainer.id;
    poll();
  });
}

function createMetadata(data, cb) {
  var body = fs.readFileSync(process.cwd() + '/' + data.files[0], 'utf8');

  var artifact = sfClient.tooling.createDeployArtifact('ApexClassMember', {
    body: fs.readFileSync(data.files[0], 'utf8'),
    contentEntityId: '01pd0000002hG4oAAE'
  });

  logger.log('using container -> ' + data.containerId);
  logger.log('uploading -> ' + data.files[0]);

  var opts = {
    id: data.containerId,
    artifact: artifact,
    oauth: data.org
  };

  sfClient.tooling.addContainerArtifact(opts, function(err, resp) {
    if(err) {
      logger.error('problem creating container artifact')
      return cb(err);
    }
    return cb(null, data);
  });
}

var run = module.exports.run = function(org, globs, opts, cb) {

  var idx;
  var containerId;
  var oauth = user.getCredential(org);
  var data = {
    globs: globs,
    org: user.getCredential(org)
  }
  var fileMap = {
    'ApexClass': {},
    'ApexPage':  {},
    'ApexComponent': {},
    'ApexTrigger': {}
  };
  var files = [];

  async.series([
    function(cb2) {
      index.getIndex(org, function(err, i) {
        if(err) return cb2(err);
        idx = i;
        console.log(i);
        cb2();
      });
    },
    function(cb2) {
      getFiles(globs, function(err, resp) {
        if(err) return cb2(err);
        files = resp;
        console.log('files');
        console.log(files);
        cb2();
      });
    },
    function(cb2) {
      _.each(files, function(f) {
        var ext = path.extname(f);
        if(ext === '.cls') {
          var mname = path.basename(f, ext);
          console.log('mname: ' + mname);
          fileMap['ApexClass'][mname] = idx.findMetaByName('ApexClass', mname);
        }
      });
      cb2();
    },
    function(cb2) {
      createContainer(data, function(err, cid) {
        if(err) return cb2(err);
        containerId = cid;
        cb2();
      });
    },
    function(cb2) {
      createMetadata(containerId, files, data.oauth, function(err, resp){
        if(err) return cb2(err);
        cb2();
      });
    }
    // createContainer,
    // createMetadata,
    // deployContainer,
    // deleteContainer
  ], function(err, result) {
    if(err) {
      return deleteContainer(data, function(err2) {
        if(err2) {
          logger.error('unable to delete metadata container');
          logger.error(err2.message);
        }
        cb(err);
      });
    }
    cb(null, result);
  });

  // async.waterfall([
  //   function(cb2) {
  //     getFiles(data, cb2)
  //   },
  //   createContainer,
  //   createMetadata,
  //   deployContainer,
  //   deleteContainer
  // ], function(err, result) {
  //   if(err) {
  //     return deleteContainer(data, function(err2) {
  //       if(err2) {
  //         logger.error('unable to delete metadata container');
  //         logger.error(err2.message);
  //       }
  //       cb(err);
  //     });
  //   }
  //   cb(null, result);
  // });
}

module.exports.cli = function(program) {
  program.command('deploy <org> [meta...]')
    .description('deploy metadata to target <org>')
    .action(function(org, globs, opts) {
      cliUtil.checkForOrg(org);
      run(org, globs, opts, cliUtil.callback);
    });
};
