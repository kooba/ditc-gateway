const { events, Job } = require('brigadier');
const kubernetes = require('@kubernetes/client-node');
const process = require('process');
const yaml = require('js-yaml');
const fetch = require('node-fetch');

const k8sClient = kubernetes.Config.defaultClient();

const BRIGADE_NAMESPACE = 'brigade';
const PROJECT_NAME = 'gateway';
const GITHUB_API_URL = 'https://api.github.com/repos/kooba/ditc-gateway';

const deploy = async (environmentName, gitSha) => {
  console.log('deploying helm charts');
  const service = new Job(
    'ditc-gateway',
    'jakubborys/ditc-brigade-worker:latest',
  );
  service.storage.enabled = false;
  service.imageForcePull = true;
  service.tasks = [
    'cd /src',
    `helm upgrade ${environmentName}-gateway \
    charts/gateway --install \
    --namespace=${environmentName} \
    --set image.tag=${gitSha} \
    --set replicaCount=1`,
  ];
  await service.run();
};

const provisionEnvironment = async (environmentName) => {
  await deploy(environmentName, process.env.BRIGADE_COMMIT_ID);
};

const getTagCommit = async (tag) => {
  console.log(`getting commit sha for tag ${tag}`);
  const tagUrl = `${GITHUB_API_URL}/git/refs/tags/${tag}`;
  const response = await fetch(
    tagUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `token ${process.env.BRIGADE_REPO_AUTH_TOKEN}`,
      },
    },
  );
  if (response.ok) {
    const commit = await response.json();
    return commit.object.sha;
  }
  throw Error(await response.text());
};

const deployToEnvironments = async (payload) => {
  const tag = payload.ref;
  const environmentConfigMaps = await k8sClient.listNamespacedConfigMap(
    BRIGADE_NAMESPACE, true, undefined, undefined, undefined,
    'type=preview-environment-config',
  );
  if (!environmentConfigMaps.body.items.length) {
    throw Error('No environment configMaps found');
  }
  for (const configMap of environmentConfigMaps.body.items) {
    const environmentsConfig = yaml.safeLoad(configMap.data.environment);
    const config = environmentsConfig[PROJECT_NAME];
    if (config && config.tag === tag) {
      const { environmentName } = configMap.metadata.labels;
      const gitSha = await getTagCommit(tag);
      await deploy(environmentName, gitSha);
    }
  }
};

const logError = (error) => {
  console.log('ERROR');
  if (error.body) {
    // Errors coming from k8s client will have all
    // relevant info in the `body` field.
    console.log(error.body);
  } else {
    console.log(error);
  }
  throw error;
};

events.on('exec', (e) => {
  /**
   * Events triggered by `brig run` command will trigger this handler.
   */
  try {
    const payload = JSON.parse(e.payload);
    const { name } = payload;
    if (!name) {
      throw Error('Environment name must be specified');
    }
    provisionEnvironment(name).catch((error) => {
      logError(error);
    });
  } catch (error) {
    logError(error);
  }
});

events.on('create', (e) => {
  /**
   * Events triggered by GitHub webhook on tag creation will trigger this handler.
   */
  try {
    const payload = JSON.parse(e.payload);
    if (payload.ref_type !== 'tag') {
      console.log('skipping, not a tag commit');
      return;
    }
    deployToEnvironments(payload).catch((error) => {
      logError(error);
    });
  } catch(error) {
    logError(error);
  }
});
