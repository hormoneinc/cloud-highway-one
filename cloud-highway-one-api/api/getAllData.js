const AWS = require('aws-sdk');
const { REQUEST_TYPES } = require('../constants');
const { checkCacheAsync, writeToCacheAsync, createCacheKey } = require('../helpers');

const docClient = new AWS.DynamoDB.DocumentClient({
  region: 'us-west-2',
  apiVersion: '2012-08-10',
  sslEnabled: true
});

/**
 * GET API to get all data in random order (all possible permutations of latencies from each region to another including itself)
 *
 * Example query: (please note that the "acknowledgement" text has to match exactly)
 *
 * /getAllData?acknowledgement=Yes_I_Understand_This_Operation_Is_Expensive_And_I_Should_Only_Make_The_Request_When_I_Really_Need_It
 *
 * @param {*} event
 * @returns a list of every possible permutations (including source region to itself) in random order.
 *
 * Example response:
 *
 * {
 *   data: [
 *     { srcProvider: 'aws', srcRegion: 'us-west-2', dstProvider: 'aws', dstRegion: 'ap-east-1', ping: 125 },
 *     { srcProvider: 'aws', srcRegion: 'eu-central-1', dstProvider: 'aws', dstRegion: 'eu-central-1', ping: 20 },
 *     ...
 *   ]
 * }
 *
 */

module.exports.getAllData = async (event) => {
  if (!event || !event.queryStringParameters) {
    return {
      statusCode: 400,
      body: 'Bad Request'
    };
  }

  const { acknowledgement } = event.queryStringParameters;

  if (
    acknowledgement !==
    'Yes_I_Understand_This_Operation_Is_Expensive_And_I_Should_Only_Make_The_Request_When_I_Really_Need_It'
  ) {
    return {
      statusCode: 400,
      body: 'Bad Request'
    };
  }

  const cacheKey = createCacheKey(REQUEST_TYPES.AllData, null);

  // Read From Cache DB
  let cachedValue;

  try {
    cachedValue = await checkCacheAsync(cacheKey);
  } catch (error) {
    console.error('logtag: dcb32b99-4a17-4778-8e4a-cd5689971926', error);
  }
  if (cachedValue) {
    console.log('logtag: 1d0f40fd-30fe-4f91-b4f1-1f944723440f', 'cache hit');
    return {
      statusCode: 200,
      body: cachedValue
    };
  }
  console.log('logtag: 3d81592a-25b9-42f2-ba0d-f0e38d166c3d', 'cache miss');

  // Read From Data DB
  // if cache miss, read from database eventually
  let lastEvaluatedKey = null;
  let responseItemsArray = [];

  do {
    const params = {
      TableName: 'CloudHighwayOne'
    };
    const paramsToContinue = {
      TableName: 'CloudHighwayOne',
      ExclusiveStartKey: lastEvaluatedKey
    };

    let response;

    try {
      // suppress eslint warnings
      // eslint-disable-next-line no-await-in-loop
      response = await docClient.scan(lastEvaluatedKey ? paramsToContinue : params).promise();
    } catch (error) {
      console.error('logtag: 457bfe75-87a9-42fc-a77e-035b2446e04c', error);
      return {
        statusCode: 500,
        body: 'Internal Server Error'
      };
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
    /* Response format:
          Items: [
            { srcRegion: 'us-west-2', dstRegion: 'aws@us-west-1', ping: 45 },
            ...
          ]
    */
    if (response.Items) {
      responseItemsArray = responseItemsArray.concat(response.Items);
    }
  } while (lastEvaluatedKey);

  const result = JSON.stringify(
    {
      data: responseItemsArray.map((x) => {
        return {
          srcProvider: x.srcRegion.split('@')[0],
          srcRegion: x.srcRegion.split('@')[1],
          dstProvider: x.dstRegion.split('@')[0],
          dstRegion: x.dstRegion.split('@')[1],
          ping: x.ping
        };
      })
    },
    null,
    2
  );

  if (result) {
    try {
      await writeToCacheAsync(cacheKey, result);
    } catch (error) {
      console.error('logtag: b4b980f7-0872-4699-9cd3-bb3be5043fd7', error);
    }
  }

  if (result) {
    return {
      statusCode: 200,
      body: result
    };
  }
  console.error('logtag: 9ddcb74f-5172-4218-9969-a829a5cbcd6c', 'no result');
  return {
    statusCode: 500,
    body: 'Internal Server Error'
  };
};
