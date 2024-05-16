import * as commander from 'commander';
import { createReadStream, existsSync, readFileSync } from 'fs';
import crypto from 'crypto';
import * as readline from 'node:readline/promises';
import { type Octokit } from 'octokit';
import { parse } from '@fast-csv/parse';
import boxen from 'boxen';
import semver from 'semver';
import { PostHog } from 'posthog-node';

import { actionRunner, checkForUpdates, logRateLimitInformation } from '../utils.js';
import VERSION from '../version.js';
import { Logger, createLogger } from '../logger.js';
import { createOctokit } from '../octokit.js';
import {
  ProjectSingleSelectFieldOptionColor,
  type Project,
  type ProjectItem,
} from '../graphql-types.js';
import { getReferencedRepositories } from '../project-items.js';
import {
  MINIMUM_SUPPORTED_GITHUB_ENTERPRISE_SERVER_VERSION_FOR_IMPORTS,
  getGitHubProductInformation,
} from '../github-products.js';
import { POSTHOG_API_KEY, POSTHOG_HOST } from '../posthog.js';

const command = new commander.Command();
const { Option } = commander;

enum ProjectOwnerType {
  Organization = 'organization',
  User = 'user',
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

interface Arguments {
  accessToken?: string;
  baseUrl: string;
  disableTelemetry: boolean;
  inputPath: string;
  projectOwner: string;
  projectOwnerType: ProjectOwnerType;
  projectTitle?: string;
  proxyUrl: string | undefined;
  repositoryMappingsPath: string;
  skipCertificateVerification: boolean;
  skipUpdateCheck: boolean;
  verbose: boolean;
}

const readRepositoryMappings = async (
  inputPath: string,
): Promise<Map<string, string>> => {
  const output = new Map<string, string>();

  return await new Promise((resolve, reject) => {
    createReadStream(inputPath, 'utf8')
      .pipe(parse({ headers: true }))
      .on('error', reject)
      .on('data', (row) => {
        const rowHeaders = Object.keys(row);

        if (
          rowHeaders.length === 2 &&
          rowHeaders.includes('source_repository') &&
          rowHeaders.includes('target_repository')
        ) {
          if (row.target_repository) {
            output.set(row.source_repository, row.target_repository);
          }
        } else {
          reject(
            new Error(
              'Your --repository-mappings-csv is invalid. Please start from a template CSV generated by the `export` command, filling out the `target_repository` field.',
            ),
          );
        }
      })
      .on('end', () => {
        resolve(output);
      });
  });
};

const getOwnerGlobalId = async ({
  octokit,
  projectOwner,
  projectOwnerType,
}: {
  octokit: Octokit;
  projectOwner: string;
  projectOwnerType: ProjectOwnerType;
}): Promise<string> => {
  switch (projectOwnerType) {
    case ProjectOwnerType.Organization:
      return await getOrganizationGlobalId({ octokit, login: projectOwner });
    case ProjectOwnerType.User:
      return await getUserGlobalId({ octokit, login: projectOwner });
  }
};

const getOrganizationGlobalId = async ({
  octokit,
  login,
}: {
  octokit: Octokit;
  login: string;
}): Promise<string> => {
  const response = (await octokit.graphql(
    `
    query getOrganizationGlobalId($login: String!) {
      organization(login: $login) {
        id
      }
    }
  `,
    { login },
  )) as { organization: { id: string } };

  return response.organization.id;
};

const getUserGlobalId = async ({
  octokit,
  login,
}: {
  octokit: Octokit;
  login: string;
}): Promise<string> => {
  const response = (await octokit.graphql(
    `
    query getUserGlobalId($login: String!) {
      user(login: $login) {
        id
      }
    }
  `,
    { login },
  )) as { user: { id: string } };

  return response.user.id;
};

const createProject = async ({
  octokit,
  ownerId,
  title,
}: {
  octokit: Octokit;
  ownerId: string;
  title: string;
}): Promise<{ id: string; url: string }> => {
  const response = (await octokit.graphql(
    `
    mutation createProject($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 {
          id
          url
        }
      }
    }
  `,
    { ownerId, title },
  )) as { createProjectV2: { projectV2: { id: string; url: string } } };

  return response.createProjectV2.projectV2;
};

interface SelectOption {
  name: string;
  color?: ProjectSingleSelectFieldOptionColor;
  description?: string;
}

interface CreatedProjectField {
  id: string;
  name: string;
  options: Array<{ id: string; name: string }>;
}

const getIssueOrPullRequestByRepositoryAndNumber = async ({
  octokit,
  owner,
  name,
  number,
}: {
  octokit: Octokit;
  owner: string;
  name: string;
  number: number;
}): Promise<{ id: string; title: string } | null> => {
  try {
    const response = (await octokit.graphql(
      `
      query getGlobalIdForIssue($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issueOrPullRequest(number: $number) {
            ... on Issue {
              id
              title
            }

            ... on PullRequest {
              id
              title
            }
          }
        }
      }
    `,
      { owner, name, number },
    )) as { repository: { issueOrPullRequest: { id: string; title: string } } };

    return response.repository.issueOrPullRequest;
  } catch (e) {
    if (e.message.includes('Could not resolve to an issue or pull request')) {
      return null;
    } else {
      throw e;
    }
  }
};

const getGlobalIdForRepository = async ({
  octokit,
  owner,
  name,
}: {
  octokit: Octokit;
  owner: string;
  name: string;
}): Promise<string> => {
  const response = (await octokit.graphql(
    `
    query getGlobalIdForRepository($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
      }
    }
  `,
    { owner, name },
  )) as { repository: { id: string } };

  return response.repository.id;
};

const addRepositoryToProject = async ({
  octokit,
  projectId,
  repositoryId,
}: {
  octokit: Octokit;
  projectId: string;
  repositoryId: string;
}): Promise<void> => {
  await octokit.graphql(
    `
    mutation addRepositoryToProject($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
        repository {
          id
        }
      }
    }
  `,
    { projectId, repositoryId },
  );
};

const archiveProjectItem = async ({
  octokit,
  projectId,
  itemId,
}: {
  octokit: Octokit;
  projectId: string;
  itemId: string;
}): Promise<void> => {
  await octokit.graphql(
    `
    mutation archiveProjectItem($projectId: ID!, $itemId: ID!) {
      archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
        item {
          id
        }
      }
    }
  `,
    { projectId, itemId },
  );
};

const addItemToProject = async ({
  octokit,
  projectId,
  contentId,
}: {
  octokit: Octokit;
  projectId: string;
  contentId: string;
}): Promise<string> => {
  const response = (await octokit.graphql(
    `
    mutation createProjectItem($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item {
          id
        }
      }
    }
  `,
    { projectId, contentId },
  )) as { addProjectV2ItemById: { item: { id: string } } };

  return response.addProjectV2ItemById.item.id;
};

const updateProjectItemFieldValue = async ({
  octokit,
  projectId,
  itemId,
  fieldId,
  value,
}: {
  octokit: Octokit;
  projectId: string;
  itemId: string;
  fieldId: string;
  value: {
    date: string | undefined;
    number: number | undefined;
    singleSelectOptionId: string | undefined;
    text: string | undefined;
  };
}): Promise<void> => {
  await octokit.graphql(
    `
    mutation updateProjectItemFieldValue($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
        projectV2Item {
          id
        }
      }
    }
  `,
    { projectId, itemId, fieldId, value },
  );
};

const createProjectField = async ({
  octokit,
  projectId,
  name,
  dataType,
  singleSelectOptions,
}: {
  octokit: Octokit;
  projectId: string;
  name: string;
  dataType: string;
  singleSelectOptions?: SelectOption[];
}): Promise<CreatedProjectField> => {
  const response = (await octokit.graphql(
    `
    mutation createProjectField($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]) {
      createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType, singleSelectOptions: $singleSelectOptions }) {
        projectV2Field {
          ... on ProjectV2Field {
            id
            name
          }
          ... on ProjectV2IterationField {
            id
            name
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            options {
              id
              name
            }
          }
        }
      }
    }`,
    { projectId, name, dataType, singleSelectOptions },
  )) as { createProjectV2Field: { projectV2Field: CreatedProjectField } };

  return response.createProjectV2Field.projectV2Field;
};

const getProjectStatusField = async ({
  octokit,
  projectId,
}: {
  octokit: Octokit;
  projectId: string;
}): Promise<{ id: string; options: Array<{ id: string; name: string }> }> => {
  const response = (await octokit.graphql(
    `query getProject($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          field(name: "Status") {
            ... on ProjectV2SingleSelectField {
              id
              options {
                id
                name
              }
            }
          }
        }
      }
    }`,
    {
      id: projectId,
    },
  )) as { node: { field: { id: string; options: Array<{ id: string; name: string }> } } };

  return response.node.field;
};

const isCustomField = ({
  dataType,
  name,
}: {
  dataType: string;
  name: string;
}): boolean => {
  return (
    ['TEXT', 'SINGLE_SELECT', 'DATE', 'NUMBER'].includes(dataType) && name !== 'Status'
  );
};

interface CustomField {
  targetId: string;
  optionMappings: Map<string, string> | null;
}

const correlateCustomFieldOptions = (
  oldOptions: Array<{ id: string; name: string }>,
  newOptions: Array<{ id: string; name: string }>,
): Map<string, string> => {
  const map = new Map<string, string>();

  if (oldOptions.length !== newOptions.length) {
    throw new Error(
      'Unable to correlate custom field options: old and new options fields have different numbers of options',
    );
  }

  for (const oldOption of oldOptions) {
    const newOption = newOptions.find((option) => option.name === oldOption.name);

    if (newOption) {
      map.set(oldOption.id, newOption.id);
    }
  }

  return map;
};

const promptUntilStatusFieldsCorrelate = async (
  {
    octokit,
    sourceProject,
    targetProjectId,
    targetProjectUrl,
  }: {
    octokit: Octokit;
    sourceProject: Project;
    targetProjectId: string;
    targetProjectUrl: string;
  },
  isFirstRun = true,
): Promise<{
  sourceProjectStatusFieldId: string;
  targetProjectStatusFieldId: string;
  mappings: Map<string, string>;
}> => {
  const sourceProjectStatusField = sourceProject.fields.nodes.find(
    (field) => field.name === 'Status',
  ) as { id: string; options: Array<{ id: string; name: string }> };
  const expectedOptions = sourceProjectStatusField.options.map((option) => option.name);

  const targetProjectStatusField = await getProjectStatusField({
    octokit,
    projectId: targetProjectId,
  });

  try {
    const mappings = correlateCustomFieldOptions(
      sourceProjectStatusField.options,
      targetProjectStatusField.options,
    );
    return {
      sourceProjectStatusFieldId: sourceProjectStatusField.id,
      targetProjectStatusFieldId: targetProjectStatusField.id,
      mappings,
    };
  } catch (e) {
    if (isFirstRun) {
      console.log(
        boxen(
          `Your new project has been created.\n\nYou now need to manually update the "Status" field's options to match your source. Here's what you need to do:\n\n1. Go to <${targetProjectUrl}/settings/fields/Status>.\n2. Make sure you have exactly the following options configured: ${expectedOptions.join(
            ', ',
          )}\n\nOnce you've done that, hit Enter and we'll check that everything looks good.`,
          { padding: 1, margin: 1, borderStyle: 'double' },
        ),
      );
    } else {
      console.log(
        boxen(
          "Your \"Status\" field's options don't look quite right. Please double check, and then when you're ready, hit Enter.",
          { padding: 1, margin: 1, borderStyle: 'double' },
        ),
      );
    }

    await rl.question('Press Enter to continue...');

    return await promptUntilStatusFieldsCorrelate(
      { octokit, sourceProject, targetProjectId, targetProjectUrl },
      false,
    );
  }
};

const isProjectItemCustomFieldValue = (field: {
  __typename: string;
  field: { name: string };
}): boolean => {
  if (
    [
      'ProjectV2ItemFieldRepositoryValue',
      'ProjectV2ItemFieldLabelValue',
      'ProjectV2ItemFieldUserValue',
      'ProjectV2ItemFieldPullRequestValue',
      'ProjectV2ItemFieldReviewerValue',
      'ProjectV2ItemFieldIterationValue',
      'ProjectV2ItemFieldMilestoneValue',
      'ProjectV2ItemFieldReviewerValue',
    ].includes(field.__typename)
  ) {
    return false;
  }

  const { name } = field.field;

  return name !== 'Title';
};

const createProjectItemReferencingIssueOrPullRequest = async ({
  sourceProjectItem,
  octokit,
  repositoryMappings,
  logger,
  targetProjectId,
}: {
  sourceProjectItem: ProjectItem;
  octokit: Octokit;
  repositoryMappings: Map<string, string>;
  logger: Logger;
  targetProjectId: string;
}): Promise<string | undefined> => {
  const sourceNameWithOwner = sourceProjectItem.content.repository.nameWithOwner;

  const destinationNameWithOwner = repositoryMappings.get(sourceNameWithOwner);

  if (!destinationNameWithOwner) {
    logger.warn(
      `Skipping project item ${sourceProjectItem.id} because there is no repository mapping for ${sourceNameWithOwner}`,
    );
    return;
  }

  const [destinationOwner, destinationName] = destinationNameWithOwner.split('/');

  const { number } = sourceProjectItem.content;

  const issueOrPullRequest = await getIssueOrPullRequestByRepositoryAndNumber({
    octokit,
    owner: destinationOwner,
    name: destinationName,
    number,
  });

  if (!issueOrPullRequest) {
    logger.warn(
      `Skipping project item ${sourceProjectItem.id} because issue/pull request ${destinationNameWithOwner}#${number} does not exist`,
    );
    return;
  }

  const { id: contentId, title } = issueOrPullRequest;

  if (sourceProjectItem.content.title !== title) {
    logger.warn(
      `The title of issue/pull request ${destinationNameWithOwner}#${number}, referenced in project item ${sourceProjectItem.id}, does not match ${sourceNameWithOwner}#${number}. You may have mapped the incorrect repository, or there may be an issue with your migration.`,
    );
  }

  const createdProjectItemId = await addItemToProject({
    octokit,
    projectId: targetProjectId,
    contentId,
  });

  return createdProjectItemId;
};

const addDraftIssueToProject = async ({
  title,
  body,
  octokit,
  targetProjectId,
}: {
  title: string;
  body: string;
  octokit: Octokit;
  targetProjectId: string;
}): Promise<string | undefined> => {
  const response = (await octokit.graphql(
    `
    mutation addDraftIssueToProject($title: String!, $body: String!, $targetProjectId: ID!) {
      addProjectV2DraftIssue(input: { title: $title, body: $body, projectId: $targetProjectId }) {
        projectItem {
          id
        }
      }
    }
  `,
    { title, body, targetProjectId },
  )) as { addProjectV2DraftIssue: { projectItem: { id: string } } };

  return response.addProjectV2DraftIssue.projectItem.id;
};

const createProjectItemReferencingDraftIssue = async ({
  octokit,
  sourceProjectItem,
  targetProjectId,
}: {
  octokit: Octokit;
  logger: Logger;
  sourceProjectItem: ProjectItem;
  targetProjectId: string;
}): Promise<string | undefined> => {
  const { title } = sourceProjectItem.content;
  const originalBody = sourceProjectItem.content.body as string;
  const creatorLogin = sourceProjectItem.content?.creator?.login as string;
  const createdAt = sourceProjectItem.content?.createdAt as string;

  const body = `**Created by \`@${creatorLogin}\` on ${createdAt}**\n\n${originalBody}`;

  return await addDraftIssueToProject({ title, body, octokit, targetProjectId });
};

const createProjectItem = async (opts: {
  sourceProjectItem: ProjectItem;
  octokit: Octokit;
  repositoryMappings: Map<string, string>;
  logger: Logger;
  targetProjectId: string;
}): Promise<string | undefined> => {
  switch (opts.sourceProjectItem.content.__typename) {
    case 'Issue':
      return await createProjectItemReferencingIssueOrPullRequest(opts);
    case 'PullRequest':
      return await createProjectItemReferencingIssueOrPullRequest(opts);
    case 'DraftIssue':
      return await createProjectItemReferencingDraftIssue(opts);
    default:
      throw new Error('Unknown content type');
  }
};

command
  .name('import')
  .version(VERSION)
  .description('Import a GitHub project')
  .option(
    '--access-token <access_token>',
    'The access token used to interact with the GitHub API. This can also be set using the IMPORT_GITHUB_TOKEN environment variable.',
  )
  .option(
    '--base-url <base_url>',
    'The base URL for the GitHub API. You only need to set this if you are migrating from a GitHub product other than GitHub.com',
    'https://api.github.com',
  )
  .requiredOption(
    '--input-path <input_path>',
    'The path to the exported project data. This will be the --project-output-path argument passed to the `export` command, which defaults to `project.json`.',
    'project.json',
  )
  .requiredOption(
    '--repository-mappings-path <repository_mappings_path>',
    'The path to your completed repository mappings file. This will be the --repository-mappings-output-path argument passed to the `export` command, which defaults to `repository-mappings.csv`.',
    'repository-mappings.csv',
  )
  .option(
    '--project-title <project_name>',
    'The title to use for the imported project. Defaults to the title of the source project.',
  )
  .requiredOption(
    '--project-owner <project_owner>',
    'The organization or user which should own the imported project',
  )
  .option(
    '--proxy-url <proxy_url>',
    'The URL of an HTTP(S) proxy to use for requests to the GitHub API (e.g. `http://localhost:3128`). This can also be set using the IMPORT_PROXY_URL environment variable.',
    process.env.IMPORT_PROXY_URL,
  )
  .option('--verbose', 'Emit detailed, verbose logs', false)
  .option(
    '--disable-telemetry',
    'Disable anonymous telemetry that gives the maintainers of this tool basic information about real-world usage. For more detailed information about the built-in telemetry, see the readme at https://github.com/timrogers/gh-migrate-project.',
    false,
  )
  .addOption(
    new Option(
      '--project-owner-type <project_owner_type>',
      'The type of the project owner',
    )
      .choices(['organization', 'user'])
      .default(ProjectOwnerType.Organization),
  )
  .option('--skip-update-check', 'Skip automatic check for updates to this tool', false)
  .option(
    '--skip-certificate-verification',
    'Skip verification of SSL certificates when connecting to GitHub. You may need to use this option if connecting to a GitHub Enterprise Server instance with a self-signed certificate, or if you have configured a proxy.',
    false,
  )
  .action(
    actionRunner(async (opts: Arguments) => {
      const {
        accessToken: accessTokenFromArguments,
        baseUrl,
        disableTelemetry,
        inputPath,
        projectOwner,
        projectOwnerType,
        projectTitle,
        proxyUrl,
        repositoryMappingsPath,
        skipCertificateVerification,
        skipUpdateCheck,
        verbose,
      } = opts;

      const logger = createLogger(verbose);

      if (skipCertificateVerification) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

      if (proxyUrl && !skipCertificateVerification) {
        logger.warn(
          'You have specified a proxy URL, but have not disabled certificate verification. This is likely to cause SSL connection errors. If you encounter SSL errors, make sure you are on a trusted network, and then try again with the --skip-certificate-verification flag.',
        );
      }

      if (!skipUpdateCheck) checkForUpdates(proxyUrl, logger);

      const posthog = new PostHog(POSTHOG_API_KEY, {
        disabled: disableTelemetry,
        host: POSTHOG_HOST,
      });

      const accessToken = accessTokenFromArguments || process.env.IMPORT_GITHUB_TOKEN;

      if (!accessToken) {
        throw new Error(
          'You must specify a GitHub access token using the --access-token argument or IMPORT_GITHUB_TOKEN environment variable.',
        );
      }

      if (!existsSync(inputPath)) {
        throw new Error(
          `The input path, \`${inputPath}\` doesn't exist. Please check the --input-path argument, and try again.`,
        );
      }

      if (!existsSync(repositoryMappingsPath)) {
        throw new Error(
          `The repository mappings path, \`${repositoryMappingsPath}\` doesn't exist. Please check the --repository-mappings-path argument, and try again.`,
        );
      }

      const octokit = createOctokit(accessToken, baseUrl, proxyUrl, logger);

      const shouldCheckRateLimitAgain = await logRateLimitInformation(logger, octokit);

      if (shouldCheckRateLimitAgain) {
        setInterval(() => {
          void logRateLimitInformation(logger, octokit);
        }, 30_000);
      }

      logger.info(`Reading project data from \`${inputPath}\`...`);
      const { project: sourceProject, projectItems: sourceProjectItems } = JSON.parse(
        readFileSync(inputPath, 'utf8'),
      ) as { project: Project; projectItems: ProjectItem[] };
      logger.info(
        `Loaded project data, including ${sourceProjectItems.length} project item(s)`,
      );

      logger.info(`Reading repository mappings from \`${repositoryMappingsPath}\`...`);
      const repositoryMappings = await readRepositoryMappings(repositoryMappingsPath);
      logger.info(`Loaded ${repositoryMappings.size} repository mapping(s)`);
      const referencedRepositories = getReferencedRepositories(sourceProjectItems);

      if (referencedRepositories.length && !repositoryMappings.size) {
        throw new Error(
          `You must update your repositories mapping file \`${repositoryMappingsPath}\` with at least one repository mapping. Please update your mappings, and try again..`,
        );
      }

      const { gitHubEnterpriseServerVersion, isGitHubEnterpriseServer } =
        await getGitHubProductInformation(octokit);

      if (isGitHubEnterpriseServer) {
        if (
          semver.lte(
            gitHubEnterpriseServerVersion,
            MINIMUM_SUPPORTED_GITHUB_ENTERPRISE_SERVER_VERSION_FOR_IMPORTS,
          )
        ) {
          throw new Error(
            `You are trying to import into GitHub Enterprise Server ${gitHubEnterpriseServerVersion}, but only ${MINIMUM_SUPPORTED_GITHUB_ENTERPRISE_SERVER_VERSION_FOR_IMPORTS} onwards is supported.`,
          );
        }

        logger.info(
          `Running export in GitHub Enterprse Server ${gitHubEnterpriseServerVersion} mode`,
        );
      } else {
        logger.info(`Running export in GitHub.com mode`);
      }

      if (!disableTelemetry) {
        posthog.capture({
          distinctId: crypto.randomUUID(),
          event: 'import_start',
          properties: {
            github_enterprise_server_version: gitHubEnterpriseServerVersion,
            is_github_enterprise_server: isGitHubEnterpriseServer,
            version: VERSION,
          },
        });
      }

      logger.info(`Looking up ID for target ${projectOwnerType} ${projectOwner}...`);
      const ownerId = await getOwnerGlobalId({ octokit, projectOwner, projectOwnerType });

      logger.info(
        `Successfully looked up ID for ${projectOwnerType} ${projectOwner}: ${ownerId}`,
      );

      const title = projectTitle || sourceProject.title;

      const { id: targetProjectId, url: targetProjectUrl } = await createProject({
        octokit,
        ownerId,
        title,
      });
      logger.info(`Created project "${title}" with ID ${targetProjectId}`);

      const sourceProjectRepositoriesCount = sourceProject.repositories.nodes.length;

      if (sourceProjectRepositoriesCount > 0) {
        logger.info(
          `Linking ${sourceProjectRepositoriesCount} repositor[y|ies] to project...`,
        );

        for (const [
          index,
          sourceProjectRepository,
        ] of sourceProject.repositories.nodes.entries()) {
          const targetRepositoryNameWithOwner = repositoryMappings.get(
            sourceProjectRepository.nameWithOwner,
          );

          if (!targetRepositoryNameWithOwner) {
            logger.warn(
              `Skipping source repository ${sourceProjectRepository.nameWithOwner} because there is no repository mapping`,
            );
            continue;
          }

          logger.info(
            `Linking repository ${targetRepositoryNameWithOwner} (${
              index + 1
            }/${sourceProjectRepositoriesCount})`,
          );

          const [targetRepositoryOwner, targetRepositoryName] =
            targetRepositoryNameWithOwner.split('/');

          const targetRepositoryId = await getGlobalIdForRepository({
            octokit,
            owner: targetRepositoryOwner,
            name: targetRepositoryName,
          });

          await addRepositoryToProject({
            octokit,
            projectId: targetProjectId,
            repositoryId: targetRepositoryId,
          });
          logger.info(
            `Linked repository ${targetRepositoryNameWithOwner} (${
              index + 1
            }/${sourceProjectRepositoriesCount})`,
          );
        }
      }

      const customFieldsToCreate = sourceProject.fields.nodes.filter(isCustomField);
      const sourceToTargetCustomFieldMappings = new Map<string, CustomField>();

      logger.info(`Creating ${customFieldsToCreate.length} custom field(s)...`);

      for (const customFieldToCreate of customFieldsToCreate) {
        const { id, dataType, name, options } = customFieldToCreate;
        const fieldOptionsForCreation = options
          ? options.map((option) => {
              const newOption = {
                name: option.name,
                description: option.description,
                color: option.color,
              } as SelectOption;

              if (typeof option.description === 'undefined') {
                logger.warn(
                  `Added a placeholder description for option "${option.name}" on custom field "${name}"`,
                );
                newOption.description = 'Placeholder description';
              }

              if (typeof option.color === 'undefined') {
                logger.warn(
                  `Added a default color for option "${option.name}" on custom field "${name}"`,
                );
                newOption.color = ProjectSingleSelectFieldOptionColor.BLUE;
              }

              return newOption;
            })
          : [];

        const createdField = await createProjectField({
          octokit,
          projectId: targetProjectId,
          name,
          dataType,
          singleSelectOptions: fieldOptionsForCreation,
        });

        // If our newly created field has options, we need to correlate the old and new option IDs
        const optionMappings = options
          ? correlateCustomFieldOptions(options, createdField.options)
          : null;

        // Store a mapping of the source customer field ID
        sourceToTargetCustomFieldMappings.set(id, {
          targetId: createdField.id,
          optionMappings,
        });
      }

      logger.info(`Created ${customFieldsToCreate.length} custom field(s)`);

      logger.info('Checking if "Status" field is configured correctly...');

      const { sourceProjectStatusFieldId, targetProjectStatusFieldId, mappings } =
        await promptUntilStatusFieldsCorrelate({
          octokit,
          sourceProject,
          targetProjectId,
          targetProjectUrl,
        });
      sourceToTargetCustomFieldMappings.set(sourceProjectStatusFieldId, {
        targetId: targetProjectStatusFieldId,
        optionMappings: mappings,
      });

      logger.info('Finished configuring "Status" field.');

      const projectItemsCount = sourceProjectItems.length;

      logger.info(`Creating ${projectItemsCount} project item(s)...`);

      for (const [itemIndex, sourceProjectItem] of sourceProjectItems.entries()) {
        logger.info(
          `Creating project item ${
            itemIndex + 1
          }/${projectItemsCount} based on source project item ${sourceProjectItem.id}...`,
        );

        const createdProjectItemId = await createProjectItem({
          octokit,
          sourceProjectItem,
          targetProjectId,
          repositoryMappings,
          logger,
        });

        if (!createdProjectItemId) {
          continue;
        }

        logger.info(
          `Created project item ${createdProjectItemId} based on source project item ${sourceProjectItem.id}`,
        );

        if (sourceProjectItem.isArchived) {
          logger.info(`Archiving project item ${createdProjectItemId}...`);
          await archiveProjectItem({
            octokit,
            projectId: targetProjectId,
            itemId: createdProjectItemId,
          });
          logger.info(`Archived project item ${createdProjectItemId}`);
        }

        const sourceProjectItemCustomFieldValues =
          sourceProjectItem.fieldValues.nodes.filter(isProjectItemCustomFieldValue);
        const customFieldsCount = sourceProjectItemCustomFieldValues.length;

        for (const [
          fieldIndex,
          sourceProjectItemCustomField,
        ] of sourceProjectItemCustomFieldValues.entries()) {
          logger.info(
            `Setting field "${sourceProjectItemCustomField.field.name}" (${
              fieldIndex + 1
            }/${customFieldsCount}) on project item ${createdProjectItemId}...`,
          );

          const fieldMapping = sourceToTargetCustomFieldMappings.get(
            sourceProjectItemCustomField.field.id,
          );

          if (!fieldMapping) {
            logger.warn(
              `Skipping field ${sourceProjectItemCustomField.field.id} because there is no mapping for the field`,
            );
            continue;
          }

          const { targetId: targetFieldId, optionMappings } = fieldMapping;
          const value = {
            date: sourceProjectItemCustomField.date,
            number: sourceProjectItemCustomField.number,
            text: sourceProjectItemCustomField.text,
            singleSelectOptionId:
              sourceProjectItemCustomField.optionId && optionMappings
                ? optionMappings.get(sourceProjectItemCustomField.optionId)
                : undefined,
          };
          await updateProjectItemFieldValue({
            octokit,
            projectId: targetProjectId,
            itemId: createdProjectItemId,
            fieldId: targetFieldId,
            value,
          });
          logger.info(
            `Finished setting field "${sourceProjectItemCustomField.field.name}" on project item ${createdProjectItemId}`,
          );
        }
      }

      console.log(
        boxen(
          `Your project and project items have been migrated. To check out your new project, head to <${targetProjectUrl}>.\n\nYou'll need to migrate your views and workflows manually`,
          { padding: 1, margin: 1, borderStyle: 'double' },
        ),
      );

      await posthog.shutdown();
      process.exit(0);
    }),
  );

export default command;
