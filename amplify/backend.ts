import 'dotenv/config';
import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { createSummitAgent } from './agent/resource';
import { createSummitKnowledgeBase, summitKnowledgeSourcePrefix } from './knowledge-base/resource';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';

const backend = defineBackend({ auth });

const authResources = (backend.auth as unknown as {
  resources: {
    userPool: cognito.UserPool;
    userPoolClient: cognito.UserPoolClient;
    cfnResources: {
      cfnIdentityPool?: { allowUnauthenticatedIdentities?: boolean };
    };
  };
}).resources;

if (authResources.cfnResources.cfnIdentityPool) {
  authResources.cfnResources.cfnIdentityPool.allowUnauthenticatedIdentities = false;
}

const agentStack = backend.createStack('SummitAgentStack');
cdk.Tags.of(agentStack).add('Project', 'aws-summit-agent');

const branchName = process.env.AWS_BRANCH;
const backendName = agentStack.node.tryGetContext('amplify-backend-name') as string | undefined;
const rawSuffix = branchName || backendName || 'dev';
const nameSuffix = rawSuffix.replace(/[^a-zA-Z0-9_]/g, '_');

const knowledgeBase = createSummitKnowledgeBase({
  stack: agentStack,
  nameSuffix,
});

const { runtime } = createSummitAgent({
  stack: agentStack,
  userPool: authResources.userPool,
  userPoolClient: authResources.userPoolClient,
  nameSuffix,
  summitKnowledgeBaseId: knowledgeBase.knowledgeBaseId,
});

backend.addOutput({
  custom: {
    agentRuntimeArn: runtime.agentRuntimeArn,
    agentRegion: agentStack.region,
    environment: nameSuffix,
    summitKnowledgeBaseId: knowledgeBase.knowledgeBaseId,
    summitKnowledgeDataSourceId: knowledgeBase.dataSourceId,
    summitKnowledgeSourceBucketName: knowledgeBase.sourceBucket.bucketName,
    summitKnowledgeSourcePrefix,
  },
});
