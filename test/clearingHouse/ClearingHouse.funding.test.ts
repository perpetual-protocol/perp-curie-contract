import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    const million = toWei(1000000)
    const thousand = toWei(1000)
    const ten = toWei(10)
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool

    beforeEach(async () => {
        // TODO WIP

        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)
        // // mint
        // collateral.mint(alice.address, million)
        // collateral.mint(bob.address, million)
        // collateral.mint(carol.address, million)
        // // approve
        // await collateral.connect(alice).approve(clearingHouse.address, million)
        // await collateral.connect(bob).approve(clearingHouse.address, million)
        // await collateral.connect(carol).approve(clearingHouse.address, million)
        // // deposit
        // await clearingHouse.connect(alice).deposit(million)
        // await clearingHouse.connect(bob).deposit(million)
        // await clearingHouse.connect(carol).deposit(million)
        // // mint quote
        // await clearingHouse.connect(alice).mint(quoteToken.address, thousand)
        // await clearingHouse.connect(bob).mint(quoteToken.address, thousand)
        // await clearingHouse.connect(carol).mint(quoteToken.address, thousand)
        // // mint base
        // await clearingHouse.connect(alice).mint(baseToken.address, ten)
        // await clearingHouse.connect(bob).mint(baseToken.address, ten)
        // await clearingHouse.connect(carol).mint(baseToken.address, ten)
    })

    describe("# updateFunding", async () => {
        let fundingBufferPeriod

        beforeEach(async () => {
            fundingBufferPeriod = (await clearingHouse.fundingPeriod()).div(2)
        })

        it("register positive premium fraction when mark price > index price", async () => {})

        it("register negative premium fraction when mark price < index price", async () => {})

        it("register zero premium fraction when mark price = index price", async () => {})

        it("can perform the very first update funding", async () => {
            // TODO WIP
        })

        it("can update funding at hour start when the previous one happens at least fundingBufferPeriod prior", async () => {
            // const originalNextFundingTime = await clearingHouse.getNextFundingTime(baseToken.address)
            // const updateFundingTimestamp = originalNextFundingTime.add(fundingBufferPeriod).subn(1)
            // await amm.mock_setBlockTimestamp(updateFundingTimestamp)
            // await amm.settleFunding()
            // expect(await amm.nextFundingTime()).eq(originalNextFundingTime.add(fundingPeriod))
        })

        it.only("consecutive update funding calls must be at least fundingBufferPeriod apart", async () => {
            await clearingHouse.updateFunding(baseToken.address)
            const originalNextFundingTime = await clearingHouse.getNextFundingTime(baseToken.address)
            const updateFundingTimestamp = originalNextFundingTime.add(fundingBufferPeriod).add(1)
            console.log(`updateFundingTimestamp: ${+updateFundingTimestamp}`)
            await waffle.provider.send("evm_setNextBlockTimestamp", [+updateFundingTimestamp])
            await clearingHouse.updateFunding(baseToken.address)
            expect(await clearingHouse.getNextFundingTime(baseToken.address)).eq(
                updateFundingTimestamp.add(fundingBufferPeriod),
            )
        })

        it("force error, can't update funding too frequently", async () => {})
    })
})
