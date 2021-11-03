import { expect } from "chai"
import { deployUpgradable } from "../../scripts/deploy/upgrades"

describe("upgradeable safe test", () => {
    it("should be revert if the implementation contract is not safe", async () => {
        const proxyExecute = {
            init: {
                methodName: "initialize",
                args: [1, 2],
            },
        }
        const errArr = ["constructor", "delegatecall", "state-variable-assignment"]

        await deployUpgradable(
            "TestUpgradeableUnsafe",
            "contracts/test/TestUpgradeableUnsafe.sol:TestUpgradeableUnsafe",
            proxyExecute,
        ).catch(async e => {
            const err = []
            for (const v of Object.values(e.errors)) {
                const error = v as any
                err.push(error.kind)
            }
            await expect(errArr).to.deep.eq(err)
        })
    })

    describe("should be revert if the upgrade contract is not safe", async () => {
        let kind: string, original: string, updated: string

        before("deploy origin contract", async () => {
            const proxyExecute = {
                init: {
                    methodName: "initialize",
                    args: ["testErc20", "testErc20"],
                },
            }
            await deployUpgradable(
                "TestUpgradeable",
                "contracts/test/TestUpgradeable.sol:TestUpgradeable",
                proxyExecute,
            )
        })
        it("insert a new variable to origin contract", async () => {
            const proxyExecuteV2 = {
                init: {
                    methodName: "initialize",
                    args: ["testErc20", "testErc20"],
                },
            }
            await deployUpgradable(
                "TestUpgradeable",
                "contracts/test/TestUpgradeableV2.sol:TestUpgradeableV2",
                proxyExecuteV2,
            ).catch(async e => {
                expect(e.report.pass).to.be.false
                expect(String(e)).contains("New variables should be placed after all existing inherited variables")
            })
        })

        it("change variable type of origin contract", async () => {
            const proxyExecuteV3 = {
                init: {
                    methodName: "initialize",
                    args: ["testErc20", "testErc20"],
                },
            }
            await deployUpgradable(
                "TestUpgradeable",
                "contracts/test/TestUpgradeableV3.sol:TestUpgradeableV3",
                proxyExecuteV3,
            ).catch(async e => {
                expect(e.report.pass).to.be.false
                expect(String(e)).contains("Bad upgrade from uint256 to int256")
            })
        })

        it("add new variable to struct of origin contract", async () => {
            const proxyExecuteV4 = {
                init: {
                    methodName: "initialize",
                    args: ["testErc20", "testErc20"],
                },
            }
            await deployUpgradable(
                "TestUpgradeable",
                "contracts/test/TestUpgradeableV4.sol:TestUpgradeableV4",
                proxyExecuteV4,
            ).catch(async e => {
                expect(String(e)).contains(
                    "Bad upgrade from struct TestUpgradeable.struct1 to struct TestUpgradeableV4.struct1",
                )
            })
        })
    })
})
