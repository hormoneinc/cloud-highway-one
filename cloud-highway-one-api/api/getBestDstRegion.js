const AWS = require('aws-sdk');
const { REQUEST_TYPES } = require('../constants');
const {
  validateRegion,
  validateCandidates,
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
 * GET API to get the region with the lowest latency from a source region
 * Up to 100 destination region candidates can be specified. If no candidates specified, it will check against all other regions.
 *
 * Example query:
 * /getBestDstRegion?srcProvider=aws&srcRegion=us-west-2&dstCandidate=aws@us-west-1&dstCandidate=aws@ap-east-1&dstCandidate=aws@eu-central-1
 *
 * @param {*} event
 * @returns a region name with its provider. e.g. "aws@us-west-1"
 */
module.exports.getBestDestinationRegionFromSourceRegion = async (event) => {
  const { srcProvider } = event.queryStringParameters;
  const { srcRegion } = event.queryStringParameters;
  let { dstCandidate } = event.multiValueQueryStringParameters; // ["aws@us-west-1","aws@ap-east-1","aws@eu-central-1"]

  if (!srcProvider || !srcRegion || !validateRegion(srcProvider, srcRegion) || !validateCandidates(dstCandidate)) {
    return {
      statusCode: 400,
      body: 'Bad Request'
    };
  }

  const srcRegionName = `${srcProvider.toLowerCase()}@${srcRegion.toLowerCase()}`;

  let cacheKey;
  let cachedValue;
  let result;
  let checkAgainstAll;

  // Read From Cache DB
  // only involve caching if there are more than 5 candidates.
  if (!dstCandidate || dstCandidate.length > 5) {
    if (!dstCandidate) {
      checkAgainstAll = true;
      dstCandidate = generateListOfAllRegionsExceptSelf(srcRegionName);
    }
    cacheKey = createCacheKey(REQUEST_TYPES.LatenciesFromOneRegionToMultiRegionCandidates, {
      src: srcRegionName,
      dst: dstCandidate.map((x) => x.toLowerCase())
    });

    if (cacheKey) {
      try {
        cachedValue = await checkCacheAsync(cacheKey);
      } catch (error) {
        console.error(error);
      }
      if (cachedValue) {
        // expect cache value to be a string in format: "{"dstRegion":"aws@us-west-1","ping":45}|{"dstRegion":"aws@ap-east-1","ping":125}|{"dstRegion":"aws@eu-central-1","ping":200}"
        try {
          const arrayOfObjects = cachedValue.split('|').map((x) => {
            return JSON.parse(x);
          });

          let minPing = Number.MAX_VALUE;
          let regionOfMinPing = null;

          for (let i = 0; i < arrayOfObjects.length; i += 1) {
            if (Number(arrayOfObjects[i].ping) < minPing) {
              minPing = Number(arrayOfObjects[i].ping);
              regionOfMinPing = arrayOfObjects[i].dstRegion;
            }
          }

          console.log('cache hit');
          result = regionOfMinPing;
        } catch (error) {
          console.error(error);
          result = null;
        }
      } else {
        console.log('cache miss');
      }
    }
  }

  // Read From Data DB
  // if skip reading from cache, or cache miss or there were errors while parsing the cached value, read from database eventually
  if (!result) {
    if (!checkAgainstAll) {
      // for requests with specified candidate regions, use batchGet to get from database. batchGet has a limitation of 100 items
      const params = {
        RequestItems: {
          CloudHighwayOne: {
            // this is the table name
            Keys: dstCandidate.map((candidate) => {
              return {
                srcRegion: srcRegionName,
                dstRegion: candidate.toLowerCase()
              };
            }),
            ProjectionExpression: 'dstRegion, ping'
          }
        }
      };
      let response;
      try {
        response = await docClient.batchGet(params).promise();
      } catch (error) {
        console.error(error);
        return {
          statusCode: 500,
          body: 'Internal Server Error'
        };
      }
      /* Response format:
        Responses: {
          CloudHighwayOne: [
            { dstRegion: 'aws@us-west-1', ping: 45 },
            { dstRegion: 'aws@ap-east-1', ping: 125 },
            { dstRegion: 'aws@eu-central-1', ping: 200 }
          ]
        }
    */
      if (response.Responses.CloudHighwayOne) {
        let minPing = Number.MAX_VALUE;
        let regionOfMinPing = null;

        for (let i = 0; i < response.Responses.CloudHighwayOne.length; i += 1) {
          if (Number(response.Responses.CloudHighwayOne[i].ping) < minPing) {
            minPing = Number(response.Responses.CloudHighwayOne[i].ping);
            regionOfMinPing = response.Responses.CloudHighwayOne[i].dstRegion;
          }
        }

        result = regionOfMinPing;

        if (result && dstCandidate.length > 5) {
          // if there is a valid result, save the **original database response** to cache,
          // do not cache the result directly since other requests may share the same latency responses
          // convert response to format: "{"dstRegion":"aws@us-west-1","ping":45}|{"dstRegion":"aws@ap-east-1","ping":125}|{"dstRegion":"aws@eu-central-1","ping":200}"
          try {
            await writeToCacheAsync(
              cacheKey,
              response.Responses.CloudHighwayOne.map((x) => JSON.stringify(x)).join('|')
            );
          } catch (error) {
            console.error(error);
          }
        }
      }
    } else {
      // if no destination regions specified, check against all other regions except source region itself
      // query is a better choice in this case

      let minPing = Number.MAX_VALUE;
      let regionOfMinPing = null;
      let lastEvaluatedKey = null;
      let responseItemsArray = [];

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
          console.error(error);
          return {
            statusCode: 500,
            body: 'Internal Server Error'
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
            // don't forget to filter out source region
            if (response.Items[i].dstRegion !== srcRegionName && Number(response.Items[i].ping) < minPing) {
              minPing = Number(response.Items[i].ping);
              regionOfMinPing = response.Items[i].dstRegion;
            }
          }
        }
      } while (lastEvaluatedKey);

      result = regionOfMinPing;

      if (result) {
        try {
          await writeToCacheAsync(cacheKey, responseItemsArray.map((x) => JSON.stringify(x)).join('|'));
        } catch (error) {
          console.error(error);
        }
      }
    }
  }

  if (result) {
    return {
      statusCode: 200,
      body: result
    };
  }
  console.error('no result');
  return {
    statusCode: 500,
    body: 'Internal Server Error'
  };
};
