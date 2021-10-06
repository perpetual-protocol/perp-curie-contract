import { expect } from "chai"
import { deployUpgradable } from "../../scripts/deploy"

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
                kind = e.report.ops[3].kind
                updated = e.report.ops[3].updated.label
                expect(kind).to.be.eq("insert")
                expect(updated).to.be.eq("num1")

                kind = e.report.ops[4].kind
                original = e.report.ops[4].original.label
                updated = e.report.ops[4].updated.label
                expect(kind).to.be.eq("replace")
                expect(original).to.be.eq("_whitelistMap")
                expect(updated).to.be.eq("str1")

                kind = e.report.ops[5].kind
                original = e.report.ops[5].original.label
                updated = e.report.ops[5].updated.label
                expect(kind).to.be.eq("replace")
                expect(original).to.be.eq("__gap")
                expect(updated).to.be.eq("num2")
            })
        })

        it("replace variable type of origin contract", async () => {
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
                kind = e.report.ops[3].kind
                original = e.report.ops[3].original.label
                updated = e.report.ops[3].updated.label
                expect(kind).to.be.eq("replace")
                expect(original).to.be.eq("_whitelistMap")
                expect(updated).to.be.eq("num1")

                kind = e.report.ops[4].kind
                original = e.report.ops[4].original.label
                updated = e.report.ops[4].updated.label
                expect(kind).to.be.eq("replace")
                expect(original).to.be.eq("__gap")
                expect(updated).to.be.eq("num2")
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
                kind = e.report.ops[3].kind
                original = e.report.ops[3].original.label
                updated = e.report.ops[3].updated.label
                expect(kind).to.be.eq("replace")
                expect(original).to.be.eq("_whitelistMap")
                expect(updated).to.be.eq("num1")

                kind = e.report.ops[4].kind
                original = e.report.ops[4].original.label
                updated = e.report.ops[4].updated.label
                expect(kind).to.be.eq("replace")
                expect(original).to.be.eq("__gap")
                expect(updated).to.be.eq("num2")
            })
        })
    })
})
