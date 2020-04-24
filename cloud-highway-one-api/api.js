const AWS = require('aws-sdk');
const { regions, MAX_DST_REGION_CANDIDATES, CACHE_TTL_IN_MINUTES } = require('./constants');

const docClient = new AWS.DynamoDB.DocumentClient({
  region: 'us-west-2',
  apiVersion: '2012-08-10',
  sslEnabled: true
});

const REQUEST_TYPES = {
  LatenciesFromOneRegionToMultiRegionCandidates: 'LatenciesFromOneRegionToMultiRegionCandidates'
};

/**
 * Validate whether a string is a valid provider name
 *
 * @param {*} provider string. e.g. "aws"
 * @returns boolean
 */
function validateProvider(provider) {
  const providers = Object.keys(regions);
  return providers.includes(provider);
}

/**
 * Validate whether provider and region is a valid combination
 *
 * @param {*} provider string. e.g. "aws"
 * @param {*} region string. e.g. "us-west-2"
 * @returns boolean
 */
function validateRegion(provider, region) {
  if (validateProvider(provider.toLowerCase())) {
    return regions[provider.toLowerCase()].includes(region.toLowerCase());
  }
  return false;
}

/**
 * Validate whether an array of destination region candidates are valid
 *
 * @param {*} dstCandidateArray e.g. ["aws@us-west-1","aws@ap-east-1","aws@eu-central-1"]
 * @returns boolean
 */
function validateCandidates(dstCandidateArray) {
  if (!dstCandidateArray) {
    // check against all regions
    return true;
  }
  if (dstCandidateArray.length > MAX_DST_REGION_CANDIDATES) {
    return false;
  }

  try {
    dstCandidateArray.forEach((x) => {
      const arraySplittedFromString = x.split('@');
      if (!validateRegion(arraySplittedFromString[0], arraySplittedFromString[1])) {
        throw new Error('Bad Request');
      }
    });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Check whether there is an exact match of the request in cache database
 *
 * A note regarding caching:
 * This caching is different from the "caching" we usually talk about. It reads and writes to database too.
 * Why do we need it:
 * Some APIs we expose actually make the same data request but do different post-processings.
 * For example, "find the best region from a source region" and "list latencies against all other regions from a source region"
 * will in fact both get all latencies from every other regions from the database. Therefore simply caching "API request -> API result" is not enough,
 * (and actually the API level caching is already taken care of by Amazon Gateway API),
 * Also taking advantage from the fact that the latency data in database is not and does not have to be in realtime (they are updated every 30 minutes by default),
 * we can cache expensive data requests and save it to database itself. For example, we can cache the response of
 * "latencies against all regions from us-west-2" and write the "DB request -> DB response" cache key-value pair to cache database. Therefore,
 * we will reduce the number of read operations from N (number of regions) to 1 next time.
 * However, since we save cache values to database as well, we don't want to involve this kind of caching when the request is small:
 * a get request of a single item does not worth caching it, as writing to cache actaully generate one more operation;
 *
 * @param {*} key cache key
 * @returns cached value or null
 */
async function checkCacheAsync(key) {
  const params = {
    TableName: 'CloudHighwayOneCache',
    Key: {
      key
    }
  };

  let response;
  try {
    response = await docClient.get(params).promise();
  } catch (error) {
    console.error(error);
    return null;
  }

  if (response.Item && response.Item.value && response.Item.ttl && response.Item.ttl > Math.floor(Date.now() / 1000)) {
    return response.Item.value;
  }
  return null;
}

/**
 * Write to cache database
 *
 * @param {*} key cache key
 * @param {*} value value to cache
 */
async function writeToCacheAsync(key, value) {
  const params = {
    TableName: 'CloudHighwayOneCache',
    Item: {
      key,
      value,
      ttl: Math.floor(Date.now() / 1000) + CACHE_TTL_IN_MINUTES * 60
    }
  };

  try {
    await docClient.put(params).promise();
  } catch (error) {
    console.error(`Writing to cache failed: ${error}`);
  }
}

/**
 * Create cache key for different types of database requests
 *
 * @param {*} requestType enum of types
 * @param {*} original see the comments below for the required schema for each request type
 * @returns cache key or null if invalid type
 */
function createCacheKey(requestType, original) {
  if (requestType === REQUEST_TYPES.LatenciesFromOneRegionToMultiRegionCandidates) {
    // expect 'original' to be in format {src: "aws@us-west-2", dst: ["aws@us-west-1","aws@ap-east-1","aws@eu-central-1"]} and all regions have been validated
    return `${original.src}+${original.dst.sort()}`;
  }
  return null;
}

/**
 * Generate an array of all regions from all providers, except the source region
 *
 * @param {*} region A complete source region name, e.g. "aws@us-west-2"
 * @returns An array of region names
 */
function generateListOfAllRegionsExceptSelf(region) {
  const providers = Object.keys(regions);
  let array;
  providers.forEach((provider) => {
    regions[provider].forEach((x) => {
      const name = `${provider}@${x}`;
      if (name !== region.toLowerCase()) {
        array.push(name);
      }
    });
  });

  return array;
}

/**
 * GET API to get the latency from source region to destination region
 *
 * Example query:
 * /getLatency?srcProvider=aws&srcRegion=us-west-2&dstProvider=aws&dstRegion=ap-east-1
 *
 * @param {*} event
 * @returns latency in ms
 */
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
    !validateRegion(srcProvider, srcRegion) ||
    !validateProvider(dstProvider, dstRegion)
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
    console.error(error);
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
