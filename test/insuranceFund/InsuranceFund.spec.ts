describe("InsuranceFund Spec", () => {
    it("has a vault")
    it.skip("has a treasury")

    describe.skip("revenue sharing", () => {
        // TODO: if the insurance ratio formula is still based on the total open interest
        it("getTotalOpenInterest")

        it("setInsuranceRatioThreshold")

        describe("getInsuranceRatio", () => {
            it("insuranceRatio = vault.balanceOf(IF) / totalOpenInterestNotional")
        })
    })
})

// TODO move to  InsuranceFund.test.ts
describe.skip("InsuranceFund integration", () => {
    describe("collect = min(usdcCollateral, (vault.balance(IF) - insuranceRatioThreshold / insuranceRatio * openInterestNotional))", () => {
        describe("collectableBalance > 0", () => {
            it("decrease vault.balanceOf(IF)")
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

        // TODO is this check necessary if the borrower is within our own system
        it("force error, vault still has balance")

        it("decrease USDC.balance(IF) if it's not 0")

        // TODO: TBC
        it.skip("provide fund from slash or liquidate staking")
    })
})

// TODO move to  ClearingHouse.insuranceFund.test.ts
describe("ClearingHouse integrates with InsuranceFund", () => {
    it("increase ch.quote.available(InsuranceFund) after every swap")

    // TODO when to settle IF's vQuote to vault? it's doable if vault can call ch.settle(IF)
    // harder to impl if CH settle itself bcs it's triggered when vault has not enough collateral
})

// TODO move to  Vault.insuranceFund.test.ts
describe.skip("Vault integrates with InsuranceFund", () => {
    it("setInsuranceFund")
    describe("the collateral is not enough for withdrawal their profit", () => {
        it("borrow from insurance fund")
        it("increase insuranceFund.balance, repay in the future")
    })

    describe("cover bad debt", () => {
        it("borrower from insurance fund, never repay")
        it("vault.balanceOf(InsuranceFund) remains the same")
    })
})
