import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse cancelExcessOrders()", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // mint
        collateral.mint(admin.address, toWei(10000))

        // prepare collateral for alice
        const amount = toWei(10, await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await collateral.connect(alice).approve(clearingHouse.address, amount)
        await clearingHouse.connect(alice).deposit(amount)

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)

        await pool.initialize(encodePriceSqrt("100", "1"))

        // alice collateral = 10
        // mint 1 base (now 1 eth = $100)
        // accountValue = 10
        // freeCollateral = 0
        // alice adds liquidity (base only) above the current price
        const baseAmount = toWei(1, await baseToken.decimals())
        await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: baseAmount,
            quote: 0,
            lowerTick: 92200, // 10092.4109643974
            upperTick: 92400, // 10296.2808943793
        })
        expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
            toWei(0), // available
            baseAmount, // debt
        ])
    })

    it("cancel alice's all open orders (single order)", async () => {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100000", 6), 0, 0, 0]
        })

        // bob as a keeper
        await expect(
            clearingHouse.connect(bob).cancelExcessOrders(alice.address, baseToken.address),
        ).to.be.not.revertedWith("CH_EAV")

        const openOrderIds = await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIds).to.deep.eq([])
    })

    it("cancel alice's all open orders (multiple orders)", async () => {
        // alice adds another liquidity (base only) above the current price
        const amount = toWei(10, await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await collateral.connect(alice).approve(clearingHouse.address, amount)
        await clearingHouse.connect(alice).deposit(amount)

        const baseAmount = toWei(1, await baseToken.decimals())
        console.log("MINT")
        await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: baseAmount,
            quote: 0,
            lowerTick: 92600,
            upperTick: 92800,
        })
        expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
            toWei(0), // available
            toWei(2), // debt
        ])

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100000", 6), 0, 0, 0]
        })

        const openOrderIdsBefore = await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore.length == 2).to.be.true

        // bob as a keeper
        await expect(
            clearingHouse.connect(bob).cancelExcessOrders(alice.address, baseToken.address),
        ).to.be.not.revertedWith("CH_EAV")

        const openOrderIds = await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIds).to.deep.eq([])
    })

    it("force fail, alice has enough account value so shouldn't be canceled", async () => {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        const openOrderIdsBefore = await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore.length == 1).to.be.true

        // bob as a keeper
        await expect(clearingHouse.cancelExcessOrders(alice.address, baseToken.address)).to.be.revertedWith("CH_EAV")

        const openOrderIdsAfter = await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore).to.deep.eq(openOrderIdsAfter)
    })
})
