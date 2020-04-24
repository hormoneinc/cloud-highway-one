const AWS = require('aws-sdk');
const { regions, MAX_DST_REGION_CANDIDATES, CACHE_TTL_IN_MINUTES, REQUEST_TYPES } = require('./constants');

const docClient = new AWS.DynamoDB.DocumentClient({
  region: 'us-west-2',
  apiVersion: '2012-08-10',
  sslEnabled: true
});

/**
 * Validate whether a string is a valid provider name
 *
 * @param {*} provider string. e.g. "aws"
 * @returns boolean
 */
const validateProvider = (provider) => {
  const providers = Object.keys(regions);
  return providers.includes(provider);
};
module.exports.validateProvider = validateProvider;

/**
 * Validate whether provider and region is a valid combination
 *
 * @param {*} provider string. e.g. "aws"
 * @param {*} region string. e.g. "us-west-2"
 * @returns boolean
 */

const validateRegion = (provider, region) => {
  if (validateProvider(provider.toLowerCase())) {
    return regions[provider.toLowerCase()].includes(region.toLowerCase());
  }
  return false;
};
module.exports.validateRegion = validateRegion;

/**
 * Validate whether an array of destination region candidates are valid
 *
 * @param {*} dstCandidateArray e.g. ["aws@us-west-1","aws@ap-east-1","aws@eu-central-1"]
 * @returns boolean
 */
module.exports.validateCandidates = (dstCandidateArray) => {
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
};

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
 * @param {*} cacheKey cache key string
 * @returns cached value string or null
 */
module.exports.checkCacheAsync = async (cacheKey) => {
  const params = {
    TableName: 'CloudHighwayOneCache',
    Key: {
      key: cacheKey.toString()
    }
  };

  let response;
  try {
    response = await docClient.get(params).promise();
  } catch (error) {
    console.error('logtag: 48abed31-aa56-4cc9-9a97-50ebe7755eff', error);
    return null;
  }

  if (response.Item && response.Item.value && response.Item.ttl && response.Item.ttl > Math.floor(Date.now() / 1000)) {
    return response.Item.value;
  }
  return null;
};

/**
 * Write to cache database
 *
 * @param {*} cacheKey cache key string
 * @param {*} cacheValue value string to becached
 */
module.exports.writeToCacheAsync = async (cacheKey, cacheValue) => {
  const params = {
    TableName: 'CloudHighwayOneCache',
    Item: {
      key: cacheKey.toString(),
      value: cacheValue.toString(),
      ttl: Math.floor(Date.now() / 1000) + CACHE_TTL_IN_MINUTES * 60
    }
  };

  try {
    await docClient.put(params).promise();
  } catch (error) {
    console.error('logtag: 0258c475-50fa-4654-af2a-ac6e19cf210b', `Writing to cache failed: ${error}`);
  }
};

/**
 * Create cache key for different types of database requests
 *
 * @param {*} requestType enum of types
 * @param {*} original see the comments below for the required schema for each request type
 * @returns cache key or null if invalid type
 */
module.exports.createCacheKey = (requestType, original) => {
  if (requestType === REQUEST_TYPES.LatenciesFromOneRegionToMultiRegionCandidates) {
    // expect 'original' to be in format {src: "aws@us-west-2", dst: ["aws@us-west-1","aws@ap-east-1","aws@eu-central-1"]} and all regions have been validated
    return `${original.src.toString().toLowerCase()}+${original.dst.sort().toString().toLowerCase()}`;
  }
  if (requestType === REQUEST_TYPES.AllData) {
    return 'ALL_DATA';
  }
  return null;
};

/**
 * Generate an array of all regions from all providers, except the source region
 *
 * @param {*} region A complete source region name, e.g. "aws@us-west-2"
 * @returns An array of region names
 */
module.exports.generateListOfAllRegionsExceptSelf = (region) => {
  const providers = Object.keys(regions);
  const array = [];
  providers.forEach((provider) => {
    regions[provider].forEach((x) => {
      const name = `${provider}@${x}`;
      if (name !== region.toLowerCase()) {
        array.push(name);
      }
    });
  });

  return array;
};
