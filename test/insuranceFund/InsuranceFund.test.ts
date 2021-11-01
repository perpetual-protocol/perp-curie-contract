// TODO feature is not implemented yet.
describe.skip("InsuranceFund integration", () => {
    describe("collect = min(usdcCollateral, (vault.balance(IF) - insuranceRatioThreshold / insuranceRatio * openInterestNotional))", () => {
        describe("collectableBalance > 0", () => {
            it("decrease vault.getBalance(IF)")
            it("increase USDC.balanceOf(treasury)")

            // TODO discuss
            it("can not collect again in x period")

            // TODO discuss
            it("called by keeper or admin")
        })
        it("force error, collectableBalance is 0")
        it("force error, invalid collector")
    })

    describe("borrow", () => {
        it("force error, invalid borrower (only vault)")

        // TODO: TBC
        it.skip("provide fund from slash or liquidate staking")
    })
})

// TODO feature is not implemented yet.
describe("ClearingHouse integrates with InsuranceFund", () => {
    // TODO when to settle IF's vQuote to vault? it's doable if vault can call ch.settle(IF)
    // harder to impl if CH settle itself bcs it's triggered when vault has not enough collateral
})

// TODO feature is not implemented yet.
describe.skip("Vault integrates with InsuranceFund", () => {
    describe("the collateral is not enough for withdrawal their profit", () => {
        it("increase insuranceFund.balance, repay in the future")
    })

    describe("cover bad debt", () => {
        it("borrower from insurance fund, never repay")
        it("vault.getBalance(InsuranceFund) remains the same")
    })
})
