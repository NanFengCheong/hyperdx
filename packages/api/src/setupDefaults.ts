import { DEFAULT_CONNECTIONS, DEFAULT_SOURCES } from '@/config';
import { createConnection, getConnections } from '@/controllers/connection';
import { createSource, getSources, updateSource } from '@/controllers/sources';
import { getTeam } from '@/controllers/team';
import logger from '@/utils/logger';

function tryParseJSON(str: string | undefined) {
  try {
    if (str != null) {
      return JSON.parse(str);
    }
  } catch (e) {
    // skip
  }
  return undefined;
}

/**
 * Sets up default connections and sources for a team
 * @param teamId The ID of the team to set up defaults for
 * @returns Promise that resolves when setup is complete
 */
export async function setupTeamDefaults(teamId: string) {
  logger.info(`Setting up defaults for team: ${teamId}`);

  const parsedDefaultConnections = tryParseJSON(DEFAULT_CONNECTIONS);
  const parsedDefaultSources = tryParseJSON(DEFAULT_SOURCES);

  if (parsedDefaultConnections == null && parsedDefaultSources == null) {
    logger.info(
      'No DEFAULT_CONNECTIONS or DEFAULT_SOURCES environment variables defined, skipping auto-provisioning',
    );
    return;
  }

  // Get the team object
  const team = await getTeam(teamId);
  if (!team) {
    logger.warn({ teamId }, 'Team not found');
    return;
  }

  // Check existing connections for this team
  const connections = await getConnections();
  const teamConnections = connections.filter(c => c.team.toString() === teamId);

  // Create default connections if none exist for this team
  if (teamConnections.length === 0 && Array.isArray(parsedDefaultConnections)) {
    logger.info(
      `No connections found for team ${teamId}, creating default connections`,
    );

    for (const connectionConfig of parsedDefaultConnections) {
      try {
        // Validate that the connection has the required fields
        if (!connectionConfig.name || !connectionConfig.host) {
          logger.warn(
            `Skipping invalid connection config: ${JSON.stringify(connectionConfig)}`,
          );
          continue;
        }

        // Create the connection
        const newConnection = await createConnection(teamId, {
          ...connectionConfig,
          password: connectionConfig.password || '',
          team: team._id,
        });

        logger.info(
          `Created default connection: ${connectionConfig.name} (${newConnection._id})`,
        );
      } catch (error) {
        logger.error({ err: error }, 'Failed to create connection');
      }
    }
  } else if (parsedDefaultConnections) {
    logger.info(
      `Connections already exist for team ${teamId}, skipping default connection creation`,
    );
  }

  // Upsert default sources by name. Missing sources (by name) are created;
  // existing sources are left untouched. This lets defaults evolve over time
  // without wiping manual edits.
  if (Array.isArray(parsedDefaultSources)) {
    const existingSources = await getSources(teamId);
    const sourcesByName: { [key: string]: any } = {};
    for (const s of existingSources) {
      if (s.name) {
        sourcesByName[s.name] = s;
      }
    }

    // Get the connections again in case we just created some
    const updatedConnections = await getConnections();
    const teamUpdatedConnections = updatedConnections.filter(
      c => c.team.toString() === teamId,
    );

    if (teamUpdatedConnections.length === 0) {
      logger.warn(
        `Cannot create default sources: no connections available for team ${teamId}`,
      );
      return;
    }

    // First pass: create any sources missing by name
    const sourceConfigsByName: { [key: string]: any } = {};
    const createdSources: { [key: string]: any } = {};

    for (const sourceConfig of parsedDefaultSources) {
      try {
        // Validate that the source has the required fields
        if (
          !sourceConfig.name ||
          !sourceConfig.kind ||
          !sourceConfig.connection
        ) {
          logger.warn(
            `Skipping invalid source config: ${JSON.stringify(sourceConfig)}`,
          );
          continue;
        }

        // Track config for the reference-resolution pass below
        sourceConfigsByName[sourceConfig.name] = sourceConfig;

        // Skip if already present (by name)
        if (sourcesByName[sourceConfig.name]) {
          logger.info(
            `Default source already exists for team ${teamId}: ${sourceConfig.name}, skipping creation`,
          );
          continue;
        }

        // Find the connection by name if string provided
        let connectionId = sourceConfig.connection;
        if (
          typeof connectionId === 'string' &&
          !connectionId.match(/^[0-9a-fA-F]{24}$/)
        ) {
          // If not a valid ObjectId, treat as a connection name
          const connection = teamUpdatedConnections.find(
            c => c.name === connectionId,
          );
          if (!connection) {
            logger.warn({ connectionId }, 'Connection not found with name');
            continue;
          }
          connectionId = connection._id.toString();
        }

        // Create a cleaned version of the source config without reference fields
        // that will be processed in the second pass
        const sourceConfigCleaned = {
          ...sourceConfig,
          connection: connectionId,
          team: team._id,
        };

        // Remove source reference fields that will be handled in the second pass
        delete sourceConfigCleaned.logSourceId;
        delete sourceConfigCleaned.traceSourceId;
        delete sourceConfigCleaned.sessionSourceId;
        delete sourceConfigCleaned.metricSourceId;

        // Create the source
        const newSource = await createSource(teamId, sourceConfigCleaned);

        logger.info(
          `Created default source: ${sourceConfig.name} (${newSource._id})`,
        );

        // Track for reference resolution and as a known source
        createdSources[sourceConfig.name] = newSource;
        sourcesByName[sourceConfig.name] = newSource;
      } catch (error) {
        logger.error({ err: error }, 'Failed to create source');
      }
    }

    // Second pass: resolve cross-source references for newly-created sources.
    // Reference targets may point at either newly-created OR pre-existing
    // sources, so look up against the merged sourcesByName map.
    const resolveRef = (name: string | undefined) => {
      if (!name) return undefined;
      const target = sourcesByName[name];
      return target ? target._id.toString() : undefined;
    };

    for (const sourceName in createdSources) {
      try {
        const sourceConfig = sourceConfigsByName[sourceName];
        const createdSource = createdSources[sourceName];

        const updateFields: { [key: string]: string } = {};

        const logRef = resolveRef(sourceConfig.logSourceId);
        if (logRef) updateFields.logSourceId = logRef;

        const traceRef = resolveRef(sourceConfig.traceSourceId);
        if (traceRef) updateFields.traceSourceId = traceRef;

        const sessionRef = resolveRef(sourceConfig.sessionSourceId);
        if (sessionRef) updateFields.sessionSourceId = sessionRef;

        const metricRef = resolveRef(sourceConfig.metricSourceId);
        if (metricRef) updateFields.metricSourceId = metricRef;

        if (Object.keys(updateFields).length > 0) {
          await updateSource(teamId, createdSource._id.toString(), {
            ...createdSource.toObject(),
            ...updateFields,
          });

          logger.info(
            `Updated source ${sourceName} with references: ${JSON.stringify(updateFields)}`,
          );
        }
      } catch (error) {
        logger.error({ err: error }, 'Failed to update source references');
      }
    }
  }
}
