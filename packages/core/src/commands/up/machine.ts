import { EOL } from 'os'
import retry from 'p-retry'
import { dateReplacer } from '@preevy/common'
import { withSpinner } from '../../spinner'
import { MachineCreationDriver, SpecDiffItem, MachineDriver, MachineConnection, MachineBase, isPartialMachine, machineResourceType } from '../../driver'
import { telemetryEmitter } from '../../telemetry'
import { Logger } from '../../log'
import { scriptExecuter } from '../../remote-script-executer'
import { EnvMetadata, driverMetadataFilename } from '../../env-metadata'
import { REMOTE_DIR_BASE } from '../../remote-files'

const machineDiffText = (diff: SpecDiffItem[]) => diff
  .map(({ name, old, new: n }) => `* ${name}: ${old} -> ${n}`).join(EOL)

type Origin = 'existing' | 'new-from-snapshot' | 'new-from-scratch'

const ensureMachine = async ({
  machineDriver,
  machineCreationDriver,
  envId,
  log,
  debug,
}: {
  machineDriver: MachineDriver
  machineCreationDriver: MachineCreationDriver
  envId: string
  log: Logger
  debug: boolean
}): Promise<{ machine: MachineBase; origin: Origin; connection: Promise<MachineConnection> }> => {
  log.debug('checking for existing machine')
  const existingMachine = await machineCreationDriver.getMachineAndSpecDiff({ envId })

  let recreating = false
  if (existingMachine) {
    if (isPartialMachine(existingMachine)) {
      recreating = true
      log.info(`Recreating machine due to error state: ${existingMachine.error}`)
    } else {
      recreating = existingMachine.specDiff.length > 0
      if (recreating) {
        log.info(`Recreating machine due to changes:${EOL}${machineDiffText(existingMachine.specDiff)}`)
      } else {
        return {
          machine: existingMachine,
          origin: 'existing',
          connection: machineDriver.connect(existingMachine, { log, debug }),
        }
      }
    }
  }

  return await withSpinner(async spinner => {
    if (existingMachine && recreating) {
      spinner.text = 'Deleting machine'
      await machineDriver.deleteResources(false, { type: machineResourceType, providerId: existingMachine.providerId })
    }
    spinner.text = 'Checking for existing snapshot'
    const machineCreation = await machineCreationDriver.createMachine({ envId })

    spinner.text = machineCreation.fromSnapshot
      ? 'Creating from existing snapshot'
      : 'No suitable snapshot yet, creating from scratch'

    telemetryEmitter().capture('create machine', { from_snapshot: machineCreation.fromSnapshot })

    const { machine, connection } = await machineCreation.result

    return {
      machine,
      connection: Promise.resolve(connection),
      origin: machineCreation.fromSnapshot ? 'new-from-snapshot' : 'new-from-scratch',
    }
  }, {
    opPrefix: `${recreating ? 'Recreating' : 'Creating'} ${machineDriver.friendlyName} machine`,
    successText: ({ origin }) => `${machineDriver.friendlyName} machine ${recreating ? 'recreated' : `created from ${origin === 'new-from-snapshot' ? 'snapshot' : 'scratch'}`}`,
  })
}

const writeMetadata = async (
  machine: MachineBase,
  machineDriverName: string,
  driverOpts: Record<string, unknown>,
  connection: MachineConnection,
  userAndGroup: [string, string],
) => {
  const metadata: Pick<EnvMetadata, 'driver'> = {
    driver: {
      creationTime: new Date(),
      providerId: machine.providerId,
      machineLocationDescription: machine.locationDescription,
      driver: machineDriverName,
      opts: driverOpts,
    },
  }
  await connection.exec(`mkdir -p "${REMOTE_DIR_BASE}" && chown "${userAndGroup.join(':')}" "${REMOTE_DIR_BASE}"`, { asRoot: true })
  await connection.exec(`cat > "${REMOTE_DIR_BASE}/${driverMetadataFilename}"`, {
    stdin: Buffer.from(JSON.stringify(metadata, dateReplacer)),
  })
}

const getUserAndGroup = async (connection: MachineConnection) => (
  await connection.exec('echo "$(id -u):$(stat -c %g /var/run/docker.sock)"')
).stdout
  .trim()
  .split(':') as [string, string]

const customizeNewMachine = ({
  log,
  debug,
  envId,
  machine,
  machineDriver,
  machineCreationDriver,
  machineDriverName,
  initialConnection,
}: {
  log: Logger
  debug: boolean
  envId: string
  machine: MachineBase
  machineDriver: MachineDriver
  machineCreationDriver: MachineCreationDriver
  machineDriverName: string
  initialConnection: MachineConnection
}) => async (spinner: { text: string }) => {
  const execScript = scriptExecuter({ exec: initialConnection.exec, log })
  let i = 0
  for (const script of machineDriver.customizationScripts ?? []) {
    i += 1
    spinner.text = `Executing customization scripts (${i}/${machineDriver.customizationScripts?.length})`
    // eslint-disable-next-line no-await-in-loop
    await execScript(script)
  }

  let connection = initialConnection
  spinner.text = 'Ensuring docker is accessible...'
  await retry(
    () => connection.exec('docker run hello-world'),
    {
      minTimeout: 2000,
      maxTimeout: 5000,
      retries: 5,
      onFailedAttempt: async err => {
        log.debug(`Failed to execute docker run hello-world: ${err}`)
        await connection.close()
        connection = await machineDriver.connect(machine, { log, debug })
      },
    }
  )

  spinner.text = 'Finalizing...'
  const userAndGroup = await getUserAndGroup(connection)

  await Promise.all([
    writeMetadata(machine, machineDriverName, machineCreationDriver.metadata, connection, userAndGroup),
    machineCreationDriver.ensureMachineSnapshot({
      providerId: machine.providerId,
      envId,
      wait: false,
    }),
  ])

  return { connection, userAndGroup, machine }
}

export const ensureCustomizedMachine = async ({
  machineDriver,
  machineCreationDriver,
  machineDriverName,
  envId,
  log,
  debug,
}: {
  machineDriver: MachineDriver
  machineCreationDriver: MachineCreationDriver
  machineDriverName: string
  envId: string
  log: Logger
  debug: boolean
}): Promise<{ machine: MachineBase; connection: MachineConnection; userAndGroup: [string, string] }> => {
  const { machine, connection: connectionPromise, origin } = await ensureMachine(
    { machineDriver, machineCreationDriver, envId, log, debug },
  )
  return await withSpinner(async spinner => {
    spinner.text = `Connecting to machine at ${machine.locationDescription}`
    const connection = await connectionPromise

    try {
      if (origin === 'new-from-scratch') {
        return await customizeNewMachine({
          log,
          debug,
          envId,
          machine,
          machineDriver,
          machineCreationDriver,
          machineDriverName,
          initialConnection: connection,
        })(spinner)
      }

      const userAndGroup = await getUserAndGroup(connection)
      if (origin === 'new-from-snapshot') {
        spinner.text = 'Finalizing...'
        await writeMetadata(machine, machineDriverName, machineCreationDriver.metadata, connection, userAndGroup)
      }

      return { machine, connection, userAndGroup }
    } catch (e) {
      await connection.close()
      throw e
    }
  }, { opPrefix: 'Configuring machine', successText: 'Machine configured' })
}
