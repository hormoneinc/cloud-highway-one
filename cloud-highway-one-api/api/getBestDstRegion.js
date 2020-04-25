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
 * GET method to get the region with the lowest latency from a source region
 *
 * Up to 100 destination region candidates can be specified. If no candidates specified, it will check against all other regions.
 *
 * For each candidate, use `@` to join destination provider name and region name, e.g. `aws@us-west-1`.
 *
 * Put one destination candidate in each `dstCandidate` query key.
 *
 * Example query:
 *
 * /getBestDstRegion?srcProvider=aws&srcRegion=us-west-2&dstCandidate=aws@us-west-1&dstCandidate=aws@ap-east-1&dstCandidate=aws@eu-central-1
 *
 * @param {*} event
 * @returns provider, region name and latency. latency in milliseconds (keep the original accuracy)
 *
 * Example response (JSON):
 *
 * {
 *   result: { dstProvider: 'aws', dstRegion: 'us-west-2', ping: 60.0498 }
 * }
 *
 */
module.exports.getBestDestinationRegionFromSourceRegion = async (event) => {
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
  let { dstCandidate } = event.multiValueQueryStringParameters; // ["aws@us-west-1","aws@ap-east-1","aws@eu-central-1"]

  if (!srcProvider || !srcRegion || !validateRegion(srcProvider, srcRegion) || !validateCandidates(dstCandidate)) {
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

  let cacheKey;
  let cachedValue;
  let result;
  let resultPing;
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
        console.error('logtag: a9a383db-2e1e-49be-ac96-d2ccab3a0072', error);
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
            // filter out source region
            if (arrayOfObjects[i].dstRegion !== srcRegionName && Number(arrayOfObjects[i].ping) < minPing) {
              minPing = Number(arrayOfObjects[i].ping);
              regionOfMinPing = arrayOfObjects[i].dstRegion;
            }
          }

          console.log('logtag: 9381def7-3884-41ed-b884-8cba52d95f3c', 'cache hit');
          result = regionOfMinPing;
          resultPing = minPing;
        } catch (error) {
          console.error('logtag: 2321e41c-a98e-4bed-838a-6504ebc01996', error);
          result = null;
          resultPing = null;
        }
      } else {
        console.log('logtag: fd085227-bf14-4c6a-aeb5-003d3a18ba07', 'cache miss');
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
        console.error('logtag: b1870162-b567-49ad-9862-3033b4e0f86e', error);
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
          // filter out source region
          if (
            response.Responses.CloudHighwayOne[i].dstRegion !== srcRegionName &&
            Number(response.Responses.CloudHighwayOne[i].ping) < minPing
          ) {
            minPing = Number(response.Responses.CloudHighwayOne[i].ping);
            regionOfMinPing = response.Responses.CloudHighwayOne[i].dstRegion;
          }
        }

        result = regionOfMinPing;
        resultPing = minPing;

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
            console.error('logtag: ca877150-9fad-46db-a27e-f637ba18f434', error);
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
          console.error('logtag: 38fcf762-a941-4334-8199-6bbe03f62e05', error);
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
            if (response.Items[i].dstRegion !== srcRegionName && Number(response.Items[i].ping) < minPing) {
              minPing = Number(response.Items[i].ping);
              regionOfMinPing = response.Items[i].dstRegion;
            }
          }
        }
      } while (lastEvaluatedKey);

      result = regionOfMinPing;
      resultPing = minPing;

      if (result) {
        try {
          await writeToCacheAsync(cacheKey, responseItemsArray.map((x) => JSON.stringify(x)).join('|'));
        } catch (error) {
          console.error('logtag: 3415871b-d434-43e9-89a4-27b6550cfb58', error);
        }
      }
    }
  }

  const returnResult = JSON.stringify(
    {
      result: {
        dstProvider: result.split('@')[0],
        dstRegion: result.split('@')[1],
        ping: resultPing
      }
    },
    null,
    2
  );

  if (result) {
    return {
      statusCode: 200,
      body: returnResult
    };
  }
  console.error('logtag: 3312da6e-262f-4e8a-8562-bedfc7332dce', 'no result');
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
