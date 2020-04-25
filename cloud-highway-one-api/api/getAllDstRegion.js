const AWS = require('aws-sdk');
const { REQUEST_TYPES } = require('../constants');
const {
  validateRegion,
  checkCacheAsync,
  writeToCacheAsync,
  createCacheKey,
  generateListOfAllRegionsExceptSelf
} = require('../helpers');

const docClient = new AWS.DynamoDB.DocumentClient({
  region: 'us-west-2',
  apiVersion: '2012-08-10',
  sslEnabled: true
});

/**
 * GET API to get the latencies against all supported regions of all providers from a source region
 *
 * Example query:
 *
 * /getAllDstRegion?srcProvider=aws&srcRegion=us-west-2
 *
 * @param {*} event
 * @returns a list of destination providers, region names and latencies (does not include the source region itself)
 * latency in milliseconds (keep the original accuracy)
 *
 * Example response (JSON):
 *
 * {
 *   data: [
 *     { dstProvider: 'aws', dstRegion: 'ap-east-1', ping: 125.5481 },
 *     { dstProvider: 'aws', dstRegion: 'eu-central-1', ping: 200.00018 },
 *     ...
 *   ]
 * }
 *
 */

module.exports.getAllInterRegionalLatenciesFromSourceRegion = async (event) => {
  if (!event || !event.queryStringParameters) {
    return {
      statusCode: 400,
      body: JSON.stringify(
        {
          error: 'Bad Request'
        },
        null,
        2
      )
    };
  }

  const { srcProvider } = event.queryStringParameters;
  const { srcRegion } = event.queryStringParameters;

  if (!srcProvider || !srcRegion || !validateRegion(srcProvider, srcRegion)) {
    return {
      statusCode: 400,
      body: JSON.stringify(
        {
          error: 'Bad Request'
        },
        null,
        2
      )
    };
  }

  const srcRegionName = `${srcProvider.toLowerCase()}@${srcRegion.toLowerCase()}`;

  let result;

  // Read From Cache DB
  const dst = generateListOfAllRegionsExceptSelf(srcRegionName);
  const cacheKey = createCacheKey(REQUEST_TYPES.LatenciesFromOneRegionToMultiRegionCandidates, {
    src: srcRegionName,
    dst: dst.map((x) => x.toLowerCase())
  });
  let cachedValue;

  if (cacheKey) {
    try {
      cachedValue = await checkCacheAsync(cacheKey);
    } catch (error) {
      console.error('logtag: 363b8d24-dbe6-4535-bc38-37e12119c5e6', error);
    }
    if (cachedValue) {
      // expect cache value to be a string in format: "{"dstRegion":"aws@us-west-1","ping":45}|{"dstRegion":"aws@ap-east-1","ping":125}|{"dstRegion":"aws@eu-central-1","ping":200}"
      try {
        const arrayOfObjects = cachedValue.split('|').map((x) => {
          return JSON.parse(x);
        });

        const resultArray = [];

        for (let i = 0; i < arrayOfObjects.length; i += 1) {
          // filter out source region
          if (arrayOfObjects[i].dstRegion !== srcRegionName) {
            resultArray.push({
              dstProvider: arrayOfObjects[i].dstRegion.split('@')[0],
              dstRegion: arrayOfObjects[i].dstRegion.split('@')[1],
              ping: arrayOfObjects[i].ping
            });
          }
        }

        console.log('logtag: d14efee8-d5f6-4e4d-97ed-b0130cd151fb', 'cache hit');
        result = JSON.stringify(
          {
            data: resultArray
          },
          null,
          2
        );
      } catch (error) {
        console.error('logtag: a1a8b28e-cebe-4e4a-b243-98c08be77c53', error);
        result = null;
      }
    } else {
      console.log('logtag: 4d2e0d50-4794-49b3-99f9-87e7a14659cb', 'cache miss');
    }
  }

  // Read From Data DB
  // if skip reading from cache, or cache miss or there were errors while parsing the cached value, read from database eventually
  if (!result) {
    let lastEvaluatedKey = null;
    let responseItemsArray = [];
    const resultArray = [];

    do {
      const params = {
        TableName: 'CloudHighwayOne',
        ExpressionAttributeValues: {
          ':source': srcRegionName
        },
        KeyConditionExpression: 'srcRegion = :source',
        ProjectionExpression: 'dstRegion, ping'
      };
      const paramsToContinue = {
        TableName: 'CloudHighwayOne',
        ExpressionAttributeValues: {
          ':source': srcRegionName
        },
        KeyConditionExpression: 'srcRegion = :source',
        ProjectionExpression: 'dstRegion, ping',
        ExclusiveStartKey: lastEvaluatedKey
      };

      let response;

      try {
        // suppress eslint warnings
        // eslint-disable-next-line no-await-in-loop
        response = await docClient.query(lastEvaluatedKey ? paramsToContinue : params).promise();
      } catch (error) {
        console.error('logtag: ff607da6-694f-448e-be23-01af1b0e0122', error);
        return {
          statusCode: 500,
          body: JSON.stringify(
            {
              error: 'Internal Server Error'
            },
            null,
            2
          )
        };
      }

      lastEvaluatedKey = response.LastEvaluatedKey;
      /* Response format:
          Items: [
            { dstRegion: 'aws@us-west-1', ping: 45 },
            { dstRegion: 'aws@ap-east-1', ping: 125 },
            { dstRegion: 'aws@eu-central-1', ping: 200 }
          ]
      */
      if (response.Items) {
        responseItemsArray = responseItemsArray.concat(response.Items);
        for (let i = 0; i < response.Items.length; i += 1) {
          // filter out source region
          if (response.Items[i].dstRegion !== srcRegionName) {
            resultArray.push({
              dstProvider: response.Items[i].dstRegion.split('@')[0],
              dstRegion: response.Items[i].dstRegion.split('@')[0],
              ping: response.Items[i].ping
            });
          }
        }
      }
    } while (lastEvaluatedKey);

    result = JSON.stringify(
      {
        data: resultArray
      },
      null,
      2
    );

    if (result) {
      try {
        await writeToCacheAsync(cacheKey, responseItemsArray.map((x) => JSON.stringify(x)).join('|'));
      } catch (error) {
        console.error('logtag: bf5c31de-c44b-4f92-9008-b610c4b4f2dd', error);
      }
    }
  }

  if (result) {
    return {
      statusCode: 200,
      body: result
    };
  }
  console.error('logtag: 9ceff11d-e448-4474-87b9-247d78077331', 'no result');
  return {
    statusCode: 500,
    body: JSON.stringify(
      {
        error: 'Internal Server Error'
      },
      null,
      2
    )
  };
};
