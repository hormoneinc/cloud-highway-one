const AWS = require('aws-sdk');
const { regions } = require('./constants');

const docClient = new AWS.DynamoDB.DocumentClient({
  region: 'us-west-2',
  apiVersion: '2012-08-10',
  sslEnabled: true
});

function checkWhetherValidProvider(provider) {
  const providers = Object.keys[regions];
  return providers.includes(provider);
}

function checkWhetherValidRegion(provider, region) {
  if (checkWhetherValidProvider(provider.toLowerCase())) {
    return regions[provider.toLowerCase()].includes(region.toLowerCase());
  }
  return false;
}

// Example request: /getLatency?srcProvider=aws&srcRegion=us-west-2&dstProvider=aws&dstRegion=ap-east-1
module.exports.interRegionalLatency = async (event) => {
  const { srcProvider } = event.queryStringParameters;
  const { srcRegion } = event.queryStringParameters;
  const { dstProvider } = event.queryStringParameters;
  const { dstRegion } = event.queryStringParameters;

  if (
    !srcProvider ||
    !srcRegion ||
    !dstProvider ||
    !dstRegion ||
    !checkWhetherValidRegion(srcProvider, srcRegion) ||
    !checkWhetherValidProvider(dstProvider, dstRegion)
  ) {
    return {
      statusCode: 400,
      body: 'Bad Request'
    };
  }

  const params = {
    TableName: 'CloudHighwayOne',
    Key: {
      srcRegion: `${srcProvider.toLowerCase()}@${srcRegion.toLowerCase()}`,
      dstRegion: `${dstProvider.toLowerCase()}@${dstRegion.toLowerCase()}`
    }
  };

  let response;
  try {
    response = await docClient.get(params).promise();
  } catch (error) {
    return {
      statusCode: 500,
      body: 'Internal Server Error'
    };
  }

  return {
    statusCode: 200,
    body: response.Item.ping
  };
};
