# Cloud Highway One

![Lint](https://github.com/hormoneinc/cloud-highway-one/workflows/Lint/badge.svg)
![Deployment](https://github.com/hormoneinc/cloud-highway-one/workflows/Deployment/badge.svg?branch=deploy%2Fping)
![API Deployment (DEV)](<https://github.com/hormoneinc/cloud-highway-one/workflows/API%20Deployment%20(DEV)/badge.svg?branch=deploy%2Fapi%2Fdev>)
![API Deployment (PROD)](<https://github.com/hormoneinc/cloud-highway-one/workflows/API%20Deployment%20(PROD)/badge.svg?branch=deploy%2Fapi%2Fprod>)

Inter-regional Latency/Ping for AWS (Azure, GCP coming soon)

![Cloud Highway One Logo](https://cdn.hormone.xyz/images/CloudHighwayOneGithubSocialPreview.png)

## What does this do?

As we deploy cloud infrastructures at a global scale, we often need to understand the network performances among each regions from different cloud providers. This project is to help you answer the following questions if you ever faced them:

- **How much is the current ping/latency between the two regions?**

  e.g. AWS Oregon (us-west-2) <=> AWS Hong Kong (ap-east-1)

- **Which is the best region to connect to from a specific source region?**

  e.g. Service A in AWS Oregon (us-west-2) need to talk to service B. Service B exists in multiple regions from multiple providers and they may change dynamically. Which region has the lowest latency to talk to at this moment?

- **How much are the pings/latencies against all other regions from a specific source region?**

  e.g.

  AWS Oregon (us-west-2) <=> AWS Hong Kong (ap-east-1)

  AWS Oregon (us-west-2) <=> AWS N. California (us-west-1)

  AWS Oregon (us-west-2) <=> AWS Hong Kong (eu-central-1)

  ...

  ......

- **I need to know all pings/latencies among all regions! (maybe for research purpose)**

  i.e. pings/latencies of all `N * N` permutations (where `N` is the number of regions)

## How can I get the data?

- You can modify the code to store/use data in the way as you wish and deploy to your own infrastructures; or,
- You can use the public API endpoints we provided for **free** (with limitations on request rates and request counts to prevent from abuse); or,
- You can pay a small amount of fee to use the public API endpoints with higher limits; or,
- You can pay higher (but still small) fee to use the public API endpoints unlimited.

### If you are interested in using the public API endpoints

Please go to [our page at RapidAPI](https://rapidapi.com/hormone-hormone-inc/api/cloud-highway-one) and follow the instructions to register.

RapidAPI.com is a third-party API marketplace; we are not associated with them in any ways.

The user interface of RapidAPI.com is a little bit counterintuitive to use (at least for me), you might need some time to get familiar with it (their service is pretty good though).

We suggest that you use our [GitHub project page](https://github.com/hormoneinc/cloud-highway-one) as your API Documentation Reference, as RapidAPI's website is super confusing and not user-friendly.

## Why are there limitations for using your API if it is open source?

Our API backend and database are hosted at AWS, so each request you make will incur fees on us. In fact, the free plan is more than enough for most users.

## API Usage Documentation

**If you are using our public API endpoints at RapidAPI.com, you also need to include a `x-rapidapi-key` to the request header. Visit [our page at RapidAPI](https://rapidapi.com/hormone-hormone-inc/api/cloud-highway-one) and follow their instructions. Use the documentation in [GitHub project page](https://github.com/hormoneinc/cloud-highway-one) as the single source of truth if there are any discrepancies between the documentations**

---

### GET Method: get the latency from a source region to a destination region

Endpoint: `/getLatency`

Required parameters:

- `srcProvider`: provider name, e.g. `aws`
- `srcRegion`: region code, e.g. `us-west-2`
- `dstProvider`: provider name, e.g. `aws`
- `dstRegion`: region code, e.g. `ap-east-1`

The latency has "directions", aka, switching source and destination region will get a different result (although they are super close)

#### Example Query

To get latency from `AWS us-west-2` region to `AWS ap-east-1` region:

```
/getLatency?srcProvider=aws&srcRegion=us-west-2&dstProvider=aws&dstRegion=ap-east-1
```

#### Example Response (JSON format, latency in milliseconds):

```
{ "ping": 143.9680204 }
```

---

### GET Method: get the region with the lowest latency from a source region.

Endpoint: `/getBestDstRegion`

Required parameters:

- `srcProvider`: provider name, e.g. `aws`
- `srcRegion`: region code, e.g. `us-west-2`

Optional parameters:

- `dstCandidate`: Use `@` to join destination provider name and region name, e.g. `aws@us-west-1`
- `dstCandidate`: this parameter can be repeated for up to 100 times
- `dstCandidate`: ...
  ...

You can specify up to **100** destination region candidates. If no candidates specified, it will check against **all** other supported regions from **all** providers.

For each candidate, use `@` to join destination provider name and region name, e.g. `aws@us-west-1`.

Put one destination candidate in each `dstCandidate` query key.

#### Example Query

To check which of the three candidate destination regions `AWS us-west-1`, `AWS ap-east-1` and `AWS eu-central-1` has the lowest latency from source region `AWS us-west-2`:

```
/getBestDstRegion?srcProvider=aws&srcRegion=us-west-2&dstCandidate=aws@us-west-1&dstCandidate=aws@ap-east-1&dstCandidate=aws@eu-central-1
```

#### Example Response (JSON format, latency in milliseconds):

```
{
  "result": { "dstProvider": "aws", "dstRegion": "us-west-2", "ping": 60.0498 }
}
```

---

### GET Method: get the latencies against all supported regions from a source region

Endpoint: `/getAllDstRegion`

Required parameters:

- `srcProvider`: provider name, e.g. `aws`
- `srcRegion`: region code, e.g. `us-west-2`

#### Example Query

To get latencies from `AWS us-west-2` region to all supported regions:

```
/getAllDstRegion?srcProvider=aws&srcRegion=us-west-2
```

#### Example Response (JSON format, latency in milliseconds):

```
  {
    data: [
      { dstProvider: 'aws', dstRegion: 'ap-east-1', ping: 125.5481 },
      { dstProvider: 'aws', dstRegion: 'eu-central-1', ping: 200.00018 },
      ...
    ]
  }
```

---

### GET Method: get the **entire** dataset (all possible permutations of latencies from each region to another including itself, in random order)

Endpoint: `/getAllData`

Required parameter:

- `acknowledgement`: use this **exact** string: `Yes_I_Understand_This_Operation_Is_Expensive_And_I_Should_Only_Make_The_Request_When_I_Really_Need_It`

#### Example Query

To get a complete latency dataset from each supported region to all regions (including itself):

```
/getAllData?acknowledgement=Yes_I_Understand_This_Operation_Is_Expensive_And_I_Should_Only_Make_The_Request_When_I_Really_Need_It
```

#### Example Response (**a large JSON**, latency in milliseconds):

```
 {
    data: [
      { srcProvider: 'aws', srcRegion: 'us-west-2', dstProvider: 'aws', dstRegion: 'ap-east-1', ping: 125.74213 },
      { srcProvider: 'aws', srcRegion: 'eu-central-1', dstProvider: 'aws', dstRegion: 'eu-central-1', ping: 20.00115 },
      ...
    ]
 }
```

## Data Freshness:

All latency data is updated **every 30 minutes**.

We may shorten the update interval (maybe to every 15 minutes, 10 minutes, 5 minutes or even shorter) in the future but we won't make it any longer, so you can rest assured that your data is always fresh.

## Data Accuracy:

All latency data is calculated from the average of 5 attempts of TCP pings (ICMP is not supported by AWS lambda functions). We keep the original accuracy and do not do any round up/down. All latency numbers are in milliseconds and do not include "ms" in the response. (e.g. `226.39222019999997`)

## Currently Supported Cloud Providers and Regions

#### Amazon Web Services:

Cloud Provider Name: `aws`

Region Names:

- `us-east-1`
- `us-east-2`
- `us-west-1`
- `us-west-2`
- `af-south-1`
- `ap-east-1`
- `ap-south-1`
- `ap-northeast-2`
- `ap-southeast-1`
- `ap-southeast-2`
- `ap-northeast-1`
- `ca-central-1`
- `eu-central-1`
- `eu-west-1`
- `eu-west-2`
- `eu-west-3`
- `eu-north-1`
- `me-south-1`
- `sa-east-1`

#### Microsoft Azure and Google Cloud Platform coming soon!

## Are the public API you provided reliable? Are you going to take them down someday?

**They are reliable!** And you can expect them to be always available except in extremely rare circumstances (for example if AWS someday decides to prohibit this kind of monitoring, or during an AWS outage, or RapidAPI outage).

We understand that the project you are working on must be mission critical if you care about inter-regional latencies this much. So are ours.

We are using the exact same API endpoints as you do.

## Open Source and Contributions

This project is completely open source and in active development.

New features and newly supported cloud providers/regions are coming soon!

Any kind of contributions are always welcome and appreciated!

If you do not want to use the public API we provided, you can easily deploy everything in your own infrastructure.

Project Repository and Complete Documentation: [https://github.com/hormoneinc/cloud-highway-one](https://github.com/hormoneinc/cloud-highway-one)

Project Owner: [Qi Xi](https://www.imxiqi.com/) ([GitHub](https://github.com/xiqi))

Hormone Open Source Project
by [Hormone Inc.](https://hormone.xyz/)

## Attribution

The project logo is inspired and derived from the [signs](https://en.wikipedia.org/wiki/Interstate_90#/media/File:I-90.svg) of [Interstate Highways in the United States](https://en.wikipedia.org/wiki/Interstate_Highway_System).

The project logo is [copyleft](https://www.gnu.org/licenses/copyleft.en.html).
