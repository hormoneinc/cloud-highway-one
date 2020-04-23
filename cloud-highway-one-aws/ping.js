const AWS = require('aws-sdk');
const tcpp = require('tcp-ping');
const { regions } = require('./constants');

const currentRegion = process.env.AWS_REGION;

const docClient = new AWS.DynamoDB.DocumentClient({
  region: 'us-west-2',
  apiVersion: '2012-08-10',
  sslEnabled: true
});

module.exports.ping = () => {
  const providers = Object.keys(regions);

  providers.forEach((provider) => {
    regions[provider].forEach((region) => {
      let host;
      if (provider === 'aws') {
        host = `ec2.${region}.amazonaws.com`;
      }
      tcpp.ping({ address: host, attempts: 5 }, (err, data) => {
        if (err) {
          console.error(err);
        } else {
          const params = {
            TableName: 'CloudHighwayOne',
            Key: {
              srcRegion: `aws@${currentRegion}`,
              dstRegion: `${provider}@${region}`
            },
            ExpressionAttributeNames: {
              '#ping': 'ping'
            },
            ExpressionAttributeValues: {
              ':value': data.avg
            },
            UpdateExpression: 'SET #ping = :value'
          };
          docClient.update(params).promise();
        }
      });
    });
  });
};
