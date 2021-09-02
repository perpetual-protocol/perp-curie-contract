import chalk from "chalk"
import { HARDHAT_NETWORK_NAME } from "hardhat/internal/constants"
import { subtask, task } from "hardhat/internal/core/config/config-env"
import { pluralize } from "hardhat/internal/util/strings"
import Mocha from "mocha"

const TASK_TEST = "test"
const TASK_COMPILE = "compile"

const TASK_TEST_RUN_SHOW_FORK_RECOMMENDATIONS = "test:show-fork-recommendations"
const TASK_TEST_RUN_MOCHA_TESTS = "test:run-mocha-tests"
const TASK_TEST_GET_TEST_FILES = "test:get-test-files"
const TASK_TEST_SETUP_TEST_ENVIRONMENT = "test:setup-test-environment"

// hardhat uses mocha version 7.1, which is too low to support parallel tests
// override the built-in mocha test subtask here, so we can use our own version of mocha
// copied from hardhat/builtin-tasks/test.ts and add parallel flag
subtask(TASK_TEST_RUN_MOCHA_TESTS)
    .addFlag("parallel", "run test in parallel")
    .setAction(async ({ testFiles, parallel }: { testFiles: string[]; parallel: boolean }, { config }) => {
        const mocha = new Mocha({ ...config.mocha, parallel: parallel })
        testFiles.forEach(file => mocha.addFile(file))

        const testFailures = await new Promise<number>(resolve => {
            mocha.run(resolve)
        })

        return testFailures
    })

// copied from hardhat/builtin-tasks/test.ts and add parallel flag to test task
task(TASK_TEST, "Runs mocha tests")
    .addFlag("parallel", "Run tests in parallel")
    .setAction(
        async (
            {
                testFiles,
                noCompile,
                parallel,
            }: {
                testFiles: string[]
                noCompile: boolean
                parallel: boolean
            },
            { run, network },
        ) => {
            if (!noCompile) {
                await run(TASK_COMPILE, { quiet: true })
            }

            const files = await run(TASK_TEST_GET_TEST_FILES, { testFiles })

            await run(TASK_TEST_SETUP_TEST_ENVIRONMENT)

            await run(TASK_TEST_RUN_SHOW_FORK_RECOMMENDATIONS)

            const testFailures = await run(TASK_TEST_RUN_MOCHA_TESTS, {
                testFiles: files,
                parallel: parallel,
            })

            if (network.name === HARDHAT_NETWORK_NAME) {
                const stackTracesFailures = await network.provider.send("hardhat_getStackTraceFailuresCount")

                if (stackTracesFailures !== 0) {
                    console.warn(
                        chalk.yellow(
                            `Failed to generate ${stackTracesFailures} ${pluralize(
                                stackTracesFailures,
                                "stack trace",
                            )}. Run Hardhat with --verbose to learn more.`,
                        ),
                    )
                }
            }

            process.exitCode = testFailures
            return testFailures
        },
    )
