// Deployed backend — CloudFormation stack `cashflow` in ap-south-1.
// (Re-run `aws cloudformation describe-stacks --stack-name cashflow` to refresh.)
window.CASHFLOW_CONFIG = {
  region: 'ap-south-1',
  identityPoolId: 'ap-south-1:b208ff89-a3bd-4eec-a716-8129728cf95d',
  apiBaseUrl: 'https://kgy33fdpp6.execute-api.ap-south-1.amazonaws.com',
  parseUrl: 'https://n34crxiwa3ka5umctcllogbgay0wjkut.lambda-url.ap-south-1.on.aws/',
  chatUrl: 'https://4enxgunygx3rgbpcmxywn5pcrq0dvrwp.lambda-url.ap-south-1.on.aws/',
  transcribeUrl: 'https://kqhqsjbbtdtf6ozmwieivhfbgm0phlvg.lambda-url.ap-south-1.on.aws/', // OpenAI speech-to-text
  cognito: {
    userPoolId: 'ap-south-1_Lw7YqfIeY',
    clientId: '7jqkkudje5i7sa84qtgsgk4g3f',
    domain: 'https://cashflow-auth-914210060536.auth.ap-south-1.amazoncognito.com',
    googleEnabled: false, // flip to true after adding Google OAuth creds in the backend
  },
};
