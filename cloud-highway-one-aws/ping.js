const AWS = require('aws-sdk');
const ping = require('ping');
const { regions } = require('./constants');

const currentRegion = process.env.AWS_REGION;

const docClient = new AWS.DynamoDB.DocumentClient({
  region: 'us-west-2',
  apiVersion: '2012-08-10',
  sslEnabled: true
});

module.exports = () => {
  const providers = Object.keys(regions);

  providers.forEach((provider) => {
    regions[provider].forEach((region) => {
      let host;
      if (provider === 'aws') {
        host = `s3.${region}.amazonaws.com`;
      }
      ping.promise
        .probe(host, {
          timeout: 5,
          min_reply: 1,
          deadline: 5
        })
        .then(({ alive, time }) => {
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
              ':value': alive ? time : 'DOWN'
            },
            UpdateExpression: 'SET #ping = :value'
          };
          docClient.update(params).promise();
        });
    });
  });
};
