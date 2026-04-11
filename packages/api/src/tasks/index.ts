import { CronJob } from 'cron';
import minimist from 'minimist';
import { serializeError } from 'serialize-error';

import { RUN_SCHEDULED_TASKS_EXTERNALLY } from '@/config';
import CheckAlertTask from '@/tasks/checkAlerts';
import CheckInactiveUsersTask from '@/tasks/checkInactiveUsers';
import DataRetentionTask from '@/tasks/dataRetention';
import ProactiveInvestigationTask from '@/tasks/proactiveInvestigation';
import {
  taskExecutionDurationGauge,
  taskExecutionFailureCounter,
  taskExecutionSuccessCounter,
  timeExec,
} from '@/tasks/metrics';
import PingPongTask from '@/tasks/pingPongTask';
import { asTaskArgs, HdxTask, TaskArgs, TaskName } from '@/tasks/types';
import logger from '@/utils/logger';

import { tasksTracer } from './tracer';

function createTask(argv: TaskArgs): HdxTask<TaskArgs> {
  const taskName = argv.taskName;
  switch (taskName) {
    case TaskName.CHECK_ALERTS:
      return new CheckAlertTask(argv);
    case TaskName.PING_PONG:
      return new PingPongTask(argv);
    case TaskName.CHECK_INACTIVE_USERS:
      return new CheckInactiveUsersTask(argv);
    case TaskName.DATA_RETENTION:
      return new DataRetentionTask(argv);
    case TaskName.PROACTIVE_INVESTIGATION:
      return new ProactiveInvestigationTask(argv);
    default:
      throw new Error(`Unknown task name ${taskName}`);
  }
}

async function main(argv: TaskArgs): Promise<void> {
  await tasksTracer.startActiveSpan(argv.taskName || 'task', async span => {
    const task: HdxTask<TaskArgs> = createTask(argv);
    try {
      logger.info(`${task.name()} started at ${new Date()}`);
      await task.execute();
      taskExecutionSuccessCounter.get(argv.taskName)?.add(1);
    } catch (e: unknown) {
      logger.error(
        {
          cause: e,
          task,
        },
        `${task.name()} failed: ${serializeError(e)}`,
      );
      taskExecutionFailureCounter.get(argv.taskName)?.add(1);
    } finally {
      await task.asyncDispose();
      span.end();
    }
  });
}

// Entry point
const argv = asTaskArgs(minimist(process.argv.slice(2)));

const instrumentedMain = timeExec(main, duration => {
  const gauge = taskExecutionDurationGauge.get(argv.taskName);
  if (gauge) {
    gauge.record(duration, { useCron: !RUN_SCHEDULED_TASKS_EXTERNALLY });
  }
  logger.info(`${argv.taskName} finished in ${duration.toFixed(2)} ms`);
});

// WARNING: the cron job will be enabled only in development mode
if (!RUN_SCHEDULED_TASKS_EXTERNALLY) {
  logger.info('In-app cron job is enabled');

  if (argv.taskName === TaskName.DATA_RETENTION) {
    // Data retention: daily at 3 AM MYT (19:00 UTC)
    logger.info('Data retention cron: daily at 3:00 AM MYT (19:00 UTC)');
    CronJob.from({
      cronTime: '0 19 * * *', // 19:00 UTC = 3:00 AM MYT
      waitForCompletion: true,
      onTick: async () => instrumentedMain(argv),
      errorHandler: async err => {
        console.error(err);
      },
      start: true,
      timeZone: 'UTC',
    });
  } else if (argv.taskName === TaskName.PROACTIVE_INVESTIGATION) {
    // Proactive investigation: every hour
    logger.info('Proactive investigation cron: every hour');
    CronJob.from({
      cronTime: '0 0 * * * *',
      waitForCompletion: true,
      onTick: async () => instrumentedMain(argv),
      errorHandler: async err => {
        console.error(err);
      },
      start: true,
      timeZone: 'UTC',
    });
  } else {
    // All other tasks: every minute
    const job = CronJob.from({
      cronTime: '0 * * * * *',
      waitForCompletion: true,
      onTick: async () => instrumentedMain(argv),
      errorHandler: async err => {
        console.error(err);
      },
      start: true,
      timeZone: 'UTC',
    });
  }
} else {
  logger.warn('In-app cron job is disabled');
  instrumentedMain(argv)
    .then(() => {
      process.exit(0);
    })
    .catch(err => {
      console.log(err);
      logger.error({ err: serializeError(err) }, 'Task execution failed');
      process.exit(1);
    });
}

process.on('uncaughtException', (err: Error) => {
  console.log(err);
  logger.error({ err: serializeError(err) }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (err: any) => {
  console.log(err);
  logger.error({ err: serializeError(err) }, 'Unhandled rejection');
  process.exit(1);
});
