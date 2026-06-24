import * as path from 'path';
import * as url from 'url';
import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { ContainerImageBuild } from 'deploy-time-build';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import type { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface SummitAgentProps {
  stack: cdk.Stack;
  userPool: IUserPool;
  userPoolClient: IUserPoolClient;
  nameSuffix: string;
  summitKnowledgeBaseId: string;
}

export function createSummitAgent({
  stack,
  userPool,
  userPoolClient,
  nameSuffix,
  summitKnowledgeBaseId,
}: SummitAgentProps) {
  const isSandbox = !process.env.AWS_BRANCH;
  const runtimePath = path.join(__dirname, 'runtime');

  let agentRuntimeArtifact: agentcore.AgentRuntimeArtifact;
  let containerImageBuild: ContainerImageBuild | undefined;

  if (isSandbox) {
    agentRuntimeArtifact = agentcore.AgentRuntimeArtifact.fromAsset(runtimePath);
  } else {
    containerImageBuild = new ContainerImageBuild(stack, 'SummitAgentImageBuild', {
      directory: runtimePath,
      platform: Platform.LINUX_ARM64,
    });

    (containerImageBuild.repository as ecr.Repository).addLifecycleRule({
      description: 'Keep last 5 images',
      maxImageCount: 5,
      rulePriority: 1,
    });

    agentRuntimeArtifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(
      containerImageBuild.repository,
      containerImageBuild.imageTag,
    );
  }

  const discoveryUrl = `https://cognito-idp.${stack.region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`;
  const runtimeName = `aws_summit_agent_${nameSuffix}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const tavilyApiSecretArn = process.env.TAVILY_API_SECRET_ARN || '';

  const runtime = new agentcore.Runtime(stack, 'SummitAgentRuntime', {
    runtimeName,
    agentRuntimeArtifact,
    authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingJWT(
      discoveryUrl,
      [userPoolClient.userPoolClientId],
    ),
    environmentVariables: {
      AWS_DEFAULT_REGION: stack.region,
      BEDROCK_REGION: stack.region,
      MODEL_ID: process.env.MODEL_ID || 'us.anthropic.claude-sonnet-4-6',
      HTTP_SUMMARY_MODEL_ID: process.env.HTTP_SUMMARY_MODEL_ID || process.env.MODEL_ID || 'us.anthropic.claude-sonnet-4-6',
      SUMMIT_KB_ID: process.env.SUMMIT_KB_ID || summitKnowledgeBaseId,
      TAVILY_API_SECRET_ARN: tavilyApiSecretArn,
      AGENT_OBSERVABILITY_ENABLED: 'true',
      OTEL_PYTHON_DISTRO: 'aws_distro',
      OTEL_PYTHON_CONFIGURATOR: 'aws_configurator',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    },
  });

  if (containerImageBuild) {
    runtime.node.addDependency(containerImageBuild);
  }

  runtime.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
    ],
    resources: [
      'arn:aws:bedrock:*::foundation-model/*',
      'arn:aws:bedrock:*:*:inference-profile/*',
    ],
  }));

  runtime.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'bedrock:Retrieve',
      'bedrock:RetrieveAndGenerate',
      'bedrock:GetKnowledgeBase',
      'bedrock:ListKnowledgeBases',
    ],
    resources: ['*'],
  }));

  if (tavilyApiSecretArn) {
    runtime.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [tavilyApiSecretArn],
    }));
  }

  new cdk.CfnOutput(stack, 'SummitAgentRuntimeArn', {
    value: runtime.agentRuntimeArn,
    description: 'AWS Summit Agent Runtime ARN',
  });

  return { runtime };
}
