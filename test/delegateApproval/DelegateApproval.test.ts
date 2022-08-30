import { expect } from "chai"
import { waffle } from "hardhat"
import { DelegateApproval, TestLimitOrderBook } from "../../typechain"
import {
    ClearingHouseWithDelegateApprovalFixture,
    createClearingHouseWithDelegateApprovalFixture,
} from "../clearingHouse/fixtures"

describe("DelegateApproval test", async () => {
    const [admin, trader] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])

    let fixture: ClearingHouseWithDelegateApprovalFixture
    let delegateApproval: DelegateApproval
    let limitOrderBook: TestLimitOrderBook
    let limitOrderBook2: TestLimitOrderBook

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseWithDelegateApprovalFixture())
        delegateApproval = fixture.delegateApproval
        limitOrderBook = fixture.limitOrderBook
        limitOrderBook2 = fixture.limitOrderBook2
    })

    describe("approve", async () => {
        it("force error, invalid actions", async () => {
            const actions = 0
            await expect(delegateApproval.connect(trader).approve(limitOrderBook.address, actions)).to.revertedWith(
                "DA_IA",
            )

            const actions2 = fixture.clearingHouseOpenPositionAction | fixture.notExistedAction
            await expect(delegateApproval.connect(trader).approve(limitOrderBook.address, actions2)).to.revertedWith(
                "DA_IA",
            )
        })

        it("approve self", async () => {
            expect(await delegateApproval.canOpenPositionFor(trader.address, trader.address)).to.be.eq(false)

            const actions = fixture.clearingHouseOpenPositionAction
            await expect(delegateApproval.connect(trader).approve(trader.address, actions))
                .to.emit(delegateApproval, "DelegationApproved")
                .withArgs(trader.address, trader.address, actions)

            expect(await delegateApproval.getApprovedActions(trader.address, trader.address)).to.be.eq(
                parseInt("00000001", 2),
            )
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    trader.address,
                    fixture.clearingHouseOpenPositionAction,
                ),
            ).to.be.eq(true)

            expect(await delegateApproval.canOpenPositionFor(trader.address, trader.address)).to.be.eq(true)
        })

        it("approve single action", async () => {
            const actions = fixture.clearingHouseOpenPositionAction
            await expect(delegateApproval.connect(trader).approve(limitOrderBook.address, actions))
                .to.emit(delegateApproval, "DelegationApproved")
                .withArgs(trader.address, limitOrderBook.address, actions)

            expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                parseInt("00000001", 2),
            )
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseOpenPositionAction,
                ),
            ).to.be.eq(true)

            expect(await delegateApproval.canOpenPositionFor(trader.address, limitOrderBook.address)).to.be.eq(true)

            // wrong actions
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseRemoveLiquidityAction,
                ),
            ).to.be.eq(false)
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseOpenPositionAction | fixture.clearingHouseRemoveLiquidityAction,
                ),
            ).to.be.eq(false)

            // wrong delegate
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook2.address,
                    fixture.clearingHouseOpenPositionAction,
                ),
            ).to.be.eq(false)
        })

        it("approve multiple actions at once", async () => {
            const actions = fixture.clearingHouseOpenPositionAction | fixture.clearingHouseAddLiquidityAction
            await expect(delegateApproval.connect(trader).approve(limitOrderBook.address, actions))
                .to.emit(delegateApproval, "DelegationApproved")
                .withArgs(trader.address, limitOrderBook.address, actions)

            expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                parseInt("00000011", 2),
            )

            // check every actions
            expect(await delegateApproval.hasApprovalFor(trader.address, limitOrderBook.address, actions)).to.be.eq(
                true,
            )

            // check each actions
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseOpenPositionAction,
                ),
            ).to.be.eq(true)
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseAddLiquidityAction,
                ),
            ).to.be.eq(true)

            expect(await delegateApproval.canOpenPositionFor(trader.address, limitOrderBook.address)).to.be.eq(true)

            // wrong actions: didn't approve clearingHouseRemoveLiquidityAction
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseOpenPositionAction | fixture.clearingHouseRemoveLiquidityAction,
                ),
            ).to.be.eq(false)
        })

        describe("approve multiple actions multiple times", () => {
            beforeEach(async () => {
                const actions = fixture.clearingHouseOpenPositionAction
                await expect(delegateApproval.connect(trader).approve(limitOrderBook.address, actions))
                    .to.emit(delegateApproval, "DelegationApproved")
                    .withArgs(trader.address, limitOrderBook.address, actions)

                expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                    parseInt("00000001", 2),
                )
                expect(
                    await delegateApproval.hasApprovalFor(
                        trader.address,
                        limitOrderBook.address,
                        fixture.clearingHouseOpenPositionAction,
                    ),
                ).to.be.eq(true)
            })

            it("approve the same action multiple times", async () => {
                const actions = fixture.clearingHouseOpenPositionAction
                await expect(delegateApproval.connect(trader).approve(limitOrderBook.address, actions))
                    .to.emit(delegateApproval, "DelegationApproved")
                    .withArgs(trader.address, limitOrderBook.address, actions)

                expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                    parseInt("00000001", 2),
                )
                expect(
                    await delegateApproval.hasApprovalFor(
                        trader.address,
                        limitOrderBook.address,
                        fixture.clearingHouseOpenPositionAction,
                    ),
                ).to.be.eq(true)

                expect(await delegateApproval.canOpenPositionFor(trader.address, limitOrderBook.address)).to.be.eq(true)
            })

            it("approve the same action multiple times with extra new action", async () => {
                const actions = fixture.clearingHouseOpenPositionAction | fixture.clearingHouseAddLiquidityAction
                await expect(delegateApproval.connect(trader).approve(limitOrderBook.address, actions))
                    .to.emit(delegateApproval, "DelegationApproved")
                    .withArgs(trader.address, limitOrderBook.address, actions)

                expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                    parseInt("00000011", 2),
                )
                expect(
                    await delegateApproval.hasApprovalFor(
                        trader.address,
                        limitOrderBook.address,
                        fixture.clearingHouseOpenPositionAction,
                    ),
                ).to.be.eq(true)
                expect(
                    await delegateApproval.hasApprovalFor(
                        trader.address,
                        limitOrderBook.address,
                        fixture.clearingHouseAddLiquidityAction,
                    ),
                ).to.be.eq(true)

                expect(await delegateApproval.canOpenPositionFor(trader.address, limitOrderBook.address)).to.be.eq(true)
            })
        })
    })

    describe("revoke", async () => {
        beforeEach(async () => {
            const actions = fixture.clearingHouseOpenPositionAction | fixture.clearingHouseAddLiquidityAction
            await expect(delegateApproval.connect(trader).approve(limitOrderBook.address, actions))
                .to.emit(delegateApproval, "DelegationApproved")
                .withArgs(trader.address, limitOrderBook.address, actions)

            expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                parseInt("00000011", 2),
            )
        })

        it("force error, invalid actions", async () => {
            const actions = 0
            await expect(delegateApproval.connect(trader).revoke(limitOrderBook.address, actions)).to.revertedWith(
                "DA_IA",
            )

            const actions2 = fixture.clearingHouseOpenPositionAction | fixture.notExistedAction
            await expect(delegateApproval.connect(trader).revoke(limitOrderBook.address, actions2)).to.revertedWith(
                "DA_IA",
            )
        })

        it("revoke self", async () => {
            const actions = fixture.clearingHouseOpenPositionAction

            await expect(delegateApproval.connect(trader).approve(trader.address, actions))
                .to.emit(delegateApproval, "DelegationApproved")
                .withArgs(trader.address, trader.address, actions)

            expect(await delegateApproval.canOpenPositionFor(trader.address, trader.address)).to.be.eq(true)

            await expect(delegateApproval.connect(trader).revoke(trader.address, actions))
                .to.emit(delegateApproval, "DelegationRevoked")
                .withArgs(trader.address, trader.address, actions)

            expect(await delegateApproval.getApprovedActions(trader.address, trader.address)).to.be.eq(
                parseInt("00000000", 2),
            )
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    trader.address,
                    fixture.clearingHouseOpenPositionAction,
                ),
            ).to.be.eq(false)

            expect(await delegateApproval.canOpenPositionFor(trader.address, trader.address)).to.be.eq(false)
        })

        it("revoke single action", async () => {
            const actions = fixture.clearingHouseOpenPositionAction
            await expect(delegateApproval.connect(trader).revoke(limitOrderBook.address, actions))
                .to.emit(delegateApproval, "DelegationRevoked")
                .withArgs(trader.address, limitOrderBook.address, actions)

            expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                parseInt("00000010", 2),
            )
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseOpenPositionAction,
                ),
            ).to.be.eq(false)
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseAddLiquidityAction,
                ),
            ).to.be.eq(true)

            expect(await delegateApproval.canOpenPositionFor(trader.address, limitOrderBook.address)).to.be.eq(false)
        })

        it("revoke multiple actions at once", async () => {
            const actions = fixture.clearingHouseOpenPositionAction | fixture.clearingHouseAddLiquidityAction
            await expect(delegateApproval.connect(trader).revoke(limitOrderBook.address, actions))
                .to.emit(delegateApproval, "DelegationRevoked")
                .withArgs(trader.address, limitOrderBook.address, actions)

            expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                parseInt("00000000", 2),
            )
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseOpenPositionAction,
                ),
            ).to.be.eq(false)
            expect(
                await delegateApproval.hasApprovalFor(
                    trader.address,
                    limitOrderBook.address,
                    fixture.clearingHouseAddLiquidityAction,
                ),
            ).to.be.eq(false)

            expect(await delegateApproval.canOpenPositionFor(trader.address, limitOrderBook.address)).to.be.eq(false)
        })

        describe("revoke multiple actions multiple times", () => {
            beforeEach(async () => {
                const actions = fixture.clearingHouseOpenPositionAction
                await expect(delegateApproval.connect(trader).revoke(limitOrderBook.address, actions))
                    .to.emit(delegateApproval, "DelegationRevoked")
                    .withArgs(trader.address, limitOrderBook.address, actions)

                expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                    parseInt("00000010", 2),
                )
                expect(
                    await delegateApproval.hasApprovalFor(
                        trader.address,
                        limitOrderBook.address,
                        fixture.clearingHouseOpenPositionAction,
                    ),
                ).to.be.eq(false)
            })

            it("revoke the same action multiple times", async () => {
                const actions = fixture.clearingHouseOpenPositionAction
                await expect(delegateApproval.connect(trader).revoke(limitOrderBook.address, actions))
                    .to.emit(delegateApproval, "DelegationRevoked")
                    .withArgs(trader.address, limitOrderBook.address, actions)

                expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                    parseInt("00000010", 2),
                )
                expect(
                    await delegateApproval.hasApprovalFor(
                        trader.address,
                        limitOrderBook.address,
                        fixture.clearingHouseOpenPositionAction,
                    ),
                ).to.be.eq(false)

                expect(await delegateApproval.canOpenPositionFor(trader.address, limitOrderBook.address)).to.be.eq(
                    false,
                )
            })

            it("revoke the same action multiple times with extra new action", async () => {
                const actions = fixture.clearingHouseOpenPositionAction | fixture.clearingHouseAddLiquidityAction
                await expect(delegateApproval.connect(trader).revoke(limitOrderBook.address, actions))
                    .to.emit(delegateApproval, "DelegationRevoked")
                    .withArgs(trader.address, limitOrderBook.address, actions)

                expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(
                    parseInt("00000000", 2),
                )
                expect(
                    await delegateApproval.hasApprovalFor(
                        trader.address,
                        limitOrderBook.address,
                        fixture.clearingHouseOpenPositionAction,
                    ),
                ).to.be.eq(false)
                expect(
                    await delegateApproval.hasApprovalFor(
                        trader.address,
                        limitOrderBook.address,
                        fixture.clearingHouseAddLiquidityAction,
                    ),
                ).to.be.eq(false)

                expect(await delegateApproval.canOpenPositionFor(trader.address, limitOrderBook.address)).to.be.eq(
                    false,
                )
            })
        })
    })

    it("getClearingHouseOpenPositionAction", async () => {
        expect(await delegateApproval.getClearingHouseOpenPositionAction()).to.be.eq(1)
    })

    it("getClearingHouseAddLiquidityAction", async () => {
        expect(await delegateApproval.getClearingHouseAddLiquidityAction()).to.be.eq(2)
    })

    it("getClearingHouseRemoveLiquidityAction", async () => {
        expect(await delegateApproval.getClearingHouseRemoveLiquidityAction()).to.be.eq(4)
    })

    it("getApprovedActions", async () => {
        // we already test getApprovedActions() in other test cases
        expect(await delegateApproval.getApprovedActions(trader.address, limitOrderBook.address)).to.be.eq(0)
    })

    describe("hasApprovalFor", async () => {
        it("force error, invalid actions", async () => {
            const actions = 0
            await expect(
                delegateApproval.hasApprovalFor(trader.address, limitOrderBook.address, actions),
            ).to.revertedWith("DA_IA")

            const actions2 = fixture.clearingHouseOpenPositionAction | fixture.notExistedAction
            await expect(
                delegateApproval.hasApprovalFor(trader.address, limitOrderBook.address, actions2),
            ).to.revertedWith("DA_IA")
        })
    })
})
