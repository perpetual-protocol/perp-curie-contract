import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse cancelExcessOrders()", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // mint
        collateral.mint(admin.address, parseUnits("10000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("10", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 10, collateral)

        await pool.initialize(encodePriceSqrt("100", "1"))
        // add pool after it's initialized
        await clearingHouse.addPool(baseToken.address, 10000)

        // alice collateral = 10
        // mint 1 base (now 1 eth = $100)
        // accountValue = 10
        // freeCollateral = 0
        // alice adds liquidity (base only) above the current price
        const baseAmount = parseUnits("1", await baseToken.decimals())
        await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: baseAmount,
            quote: 0,
            lowerTick: 92200, // 10092.4109643974
            upperTick: 92400, // 10296.2808943793
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
            parseUnits("0"), // available
            baseAmount, // debt
        ])
    })

    describe("cancel alice's all open orders (single order)", () => {
        beforeEach(async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("100000", 6), 0, 0, 0]
            })
            await clearingHouse.connect(bob).cancelExcessOrders(alice.address, baseToken.address)
        })

        it("has 0 open orders left", async () => {
            const openOrderIds = await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)
            expect(openOrderIds).to.deep.eq([])
        })

        it("burn base or base-debt to 0", async () => {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
            expect(tokenInfo.available.mul(tokenInfo.debt)).deep.eq(parseUnits("0"))
        })

        it("has either 0 quote-available or 0 quote-debt left", async () => {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            expect(tokenInfo.available.mul(tokenInfo.debt)).deep.eq(parseUnits("0"))
        })
    })

    describe("cancel alice's all open orders (multiple orders)", () => {
        beforeEach(async () => {
            // alice adds another liquidity (base only) above the current price
            const amount = parseUnits("20", await collateral.decimals())
            await collateral.transfer(alice.address, amount)
            await deposit(alice, vault, 20, collateral)

            const baseAmount = parseUnits("1", await baseToken.decimals())
            await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
            await clearingHouse.connect(alice).mint(quoteToken.address, parseUnits("100"))
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: baseAmount,
                quote: amount,
                lowerTick: 92400,
                upperTick: 92800,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("100000", 6), 0, 0, 0]
            })

            await clearingHouse.connect(bob).cancelExcessOrders(alice.address, baseToken.address)
        })

        it("has 0 open orders left", async () => {
            // bob as a keeper
            const openOrderIds = await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)
            expect(openOrderIds).to.deep.eq([])
        })

        it("has either 0 base-available or 0 base-debt left", async () => {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
            expect(tokenInfo.available.mul(tokenInfo.debt)).deep.eq(parseUnits("0"))
        })

        it("has either 0 quote-available or 0 quote-debt left", async () => {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            expect(tokenInfo.available.mul(tokenInfo.debt)).deep.eq(parseUnits("0"))
        })
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
