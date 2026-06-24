import { CfnOutput, CfnResource, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

interface SummitKnowledgeBaseProps {
  stack: Stack;
  nameSuffix: string;
}

export interface SummitKnowledgeBaseResources {
  sourceBucket: s3.Bucket;
  supplementalBucket: s3.Bucket;
  knowledgeBaseId: string;
  dataSourceId: string;
}

const SOURCE_PREFIX = 'processed/aws-summit-japan-2026/';
const EMBEDDING_MODEL_ID = 'cohere.embed-multilingual-v3';
const PARSING_INFERENCE_PROFILE_ID = 'us.anthropic.claude-sonnet-4-6';

export function createSummitKnowledgeBase({
  stack,
  nameSuffix,
}: SummitKnowledgeBaseProps): SummitKnowledgeBaseResources {
  const sanitizedSuffix = nameSuffix.replace(/_/g, '-').toLowerCase();

  const sourceBucket = new s3.Bucket(stack, 'SummitKnowledgeSourceBucket', {
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
  });

  const supplementalBucket = new s3.Bucket(stack, 'SummitKnowledgeSupplementalBucket', {
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
  });

  const vectorBucketName = `summit-agent-vectors-${sanitizedSuffix}`;
  const vectorIndexName = `summit-index-${sanitizedSuffix}`;

  const vectorBucket = new CfnResource(stack, 'SummitVectorBucket', {
    type: 'AWS::S3Vectors::VectorBucket',
    properties: {
      VectorBucketName: vectorBucketName,
    },
  });

  const vectorIndex = new CfnResource(stack, 'SummitVectorIndex', {
    type: 'AWS::S3Vectors::Index',
    properties: {
      VectorBucketName: vectorBucketName,
      IndexName: vectorIndexName,
      DataType: 'float32',
      Dimension: 1024,
      DistanceMetric: 'cosine',
      MetadataConfiguration: {
        NonFilterableMetadataKeys: [
          'AMAZON_BEDROCK_TEXT',
          'AMAZON_BEDROCK_METADATA',
        ],
      },
    },
  });
  vectorIndex.addDependency(vectorBucket);

  const knowledgeBaseRole = new iam.Role(stack, 'SummitKnowledgeBaseRole', {
    roleName: `SummitKBRole-${nameSuffix}`,
    assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
      conditions: {
        StringEquals: {
          'aws:SourceAccount': stack.account,
        },
        ArnLike: {
          'aws:SourceArn': `arn:aws:bedrock:${stack.region}:${stack.account}:knowledge-base/*`,
        },
      },
    }),
  });

  knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      'bedrock:InvokeModel',
      'bedrock:GetInferenceProfile',
      'bedrock:ListInferenceProfiles',
    ],
    resources: [
      `arn:aws:bedrock:${stack.region}::foundation-model/${EMBEDDING_MODEL_ID}`,
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${PARSING_INFERENCE_PROFILE_ID}`,
    ],
  }));

  knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      's3:GetObject',
      's3:ListBucket',
    ],
    resources: [
      sourceBucket.bucketArn,
      `${sourceBucket.bucketArn}/*`,
    ],
  }));

  knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      's3:GetObject',
      's3:PutObject',
      's3:DeleteObject',
      's3:ListBucket',
    ],
    resources: [
      supplementalBucket.bucketArn,
      `${supplementalBucket.bucketArn}/*`,
    ],
  }));

  supplementalBucket.addToResourcePolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
    actions: [
      's3:GetObject',
      's3:PutObject',
      's3:DeleteObject',
      's3:ListBucket',
    ],
    resources: [
      supplementalBucket.bucketArn,
      `${supplementalBucket.bucketArn}/*`,
    ],
    conditions: {
      StringEquals: {
        'aws:SourceAccount': stack.account,
      },
    },
  }));

  knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      's3vectors:CreateIndex',
      's3vectors:GetIndex',
      's3vectors:DeleteIndex',
      's3vectors:ListIndexes',
      's3vectors:PutVectors',
      's3vectors:GetVectors',
      's3vectors:DeleteVectors',
      's3vectors:QueryVectors',
    ],
    resources: ['*'],
  }));

  const knowledgeBase = new bedrock.CfnKnowledgeBase(stack, 'SummitKnowledgeBase', {
    name: `aws-summit-kb-${nameSuffix}`,
    description: 'AWS Summit Japan 2026 official and community knowledge base',
    roleArn: knowledgeBaseRole.roleArn,
    knowledgeBaseConfiguration: {
      type: 'VECTOR',
      vectorKnowledgeBaseConfiguration: {
        embeddingModelArn: `arn:aws:bedrock:${stack.region}::foundation-model/${EMBEDDING_MODEL_ID}`,
        supplementalDataStorageConfiguration: {
          supplementalDataStorageLocations: [
            {
              supplementalDataStorageLocationType: 'S3',
              s3Location: {
                uri: `s3://${supplementalBucket.bucketName}`,
              },
            },
          ],
        },
      },
    },
    storageConfiguration: {
      type: 'S3_VECTORS',
      s3VectorsConfiguration: {
        indexArn: vectorIndex.getAtt('IndexArn').toString(),
      },
    },
  });
  knowledgeBase.addDependency(vectorIndex);
  knowledgeBase.node.addDependency(knowledgeBaseRole);
  knowledgeBase.node.addDependency(supplementalBucket);

  const dataSource = new bedrock.CfnDataSource(stack, 'SummitKnowledgeDataSource', {
    knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
    name: `aws-summit-ds-${nameSuffix}`,
    description: 'AWS Summit Japan 2026 curated Markdown and official PDF sources',
    dataDeletionPolicy: 'DELETE',
    dataSourceConfiguration: {
      type: 'S3',
      s3Configuration: {
        bucketArn: sourceBucket.bucketArn,
        inclusionPrefixes: [SOURCE_PREFIX],
      },
    },
    vectorIngestionConfiguration: {
      chunkingConfiguration: {
        chunkingStrategy: 'HIERARCHICAL',
        hierarchicalChunkingConfiguration: {
          levelConfigurations: [
            { maxTokens: 1500 },
            { maxTokens: 300 },
          ],
          overlapTokens: 60,
        },
      },
      parsingConfiguration: {
        parsingStrategy: 'BEDROCK_FOUNDATION_MODEL',
        bedrockFoundationModelConfiguration: {
          modelArn: `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${PARSING_INFERENCE_PROFILE_ID}`,
          parsingModality: 'MULTIMODAL',
        },
      },
    },
  });
  dataSource.addDependency(knowledgeBase);

  new CfnOutput(stack, 'SummitKnowledgeBaseId', {
    value: knowledgeBase.attrKnowledgeBaseId,
    description: 'Bedrock Knowledge Base ID for AWS Summit Agent',
  });

  new CfnOutput(stack, 'SummitKnowledgeDataSourceId', {
    value: dataSource.attrDataSourceId,
    description: 'Bedrock Knowledge Base data source ID for AWS Summit Agent',
  });

  new CfnOutput(stack, 'SummitKnowledgeSourceBucketName', {
    value: sourceBucket.bucketName,
    description: 'S3 bucket for AWS Summit Knowledge Base source documents',
  });

  return {
    sourceBucket,
    supplementalBucket,
    knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
    dataSourceId: dataSource.attrDataSourceId,
  };
}

export { SOURCE_PREFIX as summitKnowledgeSourcePrefix };
