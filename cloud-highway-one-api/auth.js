const generatePolicy = (principalId, effect, resource) => {
  const authResponse = {};
  authResponse.principalId = principalId;
  if (effect && resource) {
    const policyDocument = {};
    policyDocument.Version = '2012-10-17';
    policyDocument.Statement = [];
    const statementOne = {};
    statementOne.Action = 'execute-api:Invoke';
    statementOne.Effect = effect;
    statementOne.Resource = resource;
    policyDocument.Statement[0] = statementOne;
    authResponse.policyDocument = policyDocument;
  }
  return authResponse;
};

const generateAllow = (principalId, resource) => {
  return generatePolicy(principalId, 'Allow', resource);
};

module.exports.authorize = (event, context, callback) => {
  console.log(event.headers['X-RapidAPI-Proxy-Secret']);
  console.log(process.env.RAPID_API_SECRET_KEY);
  if (process.env.RAPID_API_SECRET_KEY === event.headers['X-RapidAPI-Proxy-Secret']) {
    callback(null, generateAllow('RapidAPI', event.methodArn));
  } else {
    callback('Unauthorized');
  }
};
