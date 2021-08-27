import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, Exchange, InsuranceFund, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse insurance fee in v3 pool", () => {
    const [admin, maker1, maker2, taker1] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let exchange: Exchange
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        exchange = _clearingHouseFixture.exchange
        vault = _clearingHouseFixture.vault
        insuranceFund = _clearingHouseFixture.insuranceFund
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })
        await pool.initialize(encodePriceSqrt(100, 1))

        await exchange.addPool(baseToken.address, "10000")
        await clearingHouse.setInsuranceFundFeeRatio(baseToken.address, "400000")

        // prepare collateral for maker1
        await collateral.mint(maker1.address, parseUnits("1000", collateralDecimals))
        await deposit(maker1, vault, 1000, collateral)
        await clearingHouse.connect(maker1).mint(baseToken.address, parseEther("0.000816820841"))
        await clearingHouse.connect(maker1).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("0.000816820841"),
            quote: 0,
            lowerTick: 50000,
            upperTick: 50200,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for maker2
        await collateral.mint(maker2.address, parseUnits("1000", collateralDecimals))
        await deposit(maker2, vault, 1000, collateral)
        await clearingHouse.connect(maker2).mint(baseToken.address, parseEther("0.0008086937422"))
        await clearingHouse.connect(maker2).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("0.0008086937422"),
            quote: 0,
            lowerTick: 50200,
            upperTick: 50400,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker1 and taker 2
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker1.address, takerCollateral)
        await collateral.connect(taker1).approve(clearingHouse.address, takerCollateral)
        await deposit(taker1, vault, 1000, collateral)
    })

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=523274954
    it("quote to base: 0.001633641682q => 0.244829292B, maker get fee", async () => {
        await clearingHouse.connect(taker1).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther("0.001633641682"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // check maker & insurance fund's fee
        const resp1 = await clearingHouse.connect(maker1).callStatic.removeLiquidity({
            baseToken: baseToken.address,
            lowerTick: 50000,
            upperTick: 50200,
            liquidity: "0",
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        // 0.001633641682 * 1% * 60% * 100% = 0.000009801850092
        expect(resp1.fee).eq(parseEther("0.000009801850091999"))

        const resp2 = await clearingHouse.connect(maker2).callStatic.removeLiquidity({
            baseToken: baseToken.address,
            lowerTick: 50200,
            upperTick: 50400,
            liquidity: "0",
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        expect(resp2.fee).eq(0)

        const owedRealizedPnl = await clearingHouse.getOwedRealizedPnl(insuranceFund.address)
        // 0.001633641682 * 1% * 40% ~= 0.8
        expect(owedRealizedPnl).eq(parseEther("0.000006534566728"))
    })

    it("cross multiple ticks", async () => {
        await clearingHouse.connect(taker1).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            oppositeAmountBound: 0,
            // make sure uniswapV3pool get the same numbers as spreadsheet
            amount: parseEther((0.122414646 / 0.99).toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        await clearingHouse.connect(taker1).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther((0.1236448718 / 0.99).toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // check maker & insurance fund's fee
        const resp1 = await clearingHouse.connect(maker1).callStatic.removeLiquidity({
            baseToken: baseToken.address,
            lowerTick: 50000,
            upperTick: 50200,
            liquidity: "0",
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        // 0.122414646/0.99 * 1% * 60% * 100% = 0.0007419069455
        expect(resp1.fee).eq(parseEther("0.000741906945369186"))

        const resp2 = await clearingHouse.connect(maker2).callStatic.removeLiquidity({
            baseToken: baseToken.address,
            lowerTick: 50200,
            upperTick: 50400,
            liquidity: "0",
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        // 0.1236448718/0.99 * 1% * 60% * 100% ~= 0.0007493628594
        expect(resp2.fee).eq(parseEther("0.000749362859479297"))

        const owedRealizedPnl = await clearingHouse.getOwedRealizedPnl(insuranceFund.address)
        // ((0.122414646 / 0.99) + (0.1236448718 / 0.99)) * 1% * 40% ~= 0.0009941798699
        expect(owedRealizedPnl).eq(parseEther("0.000994179869898991"))
    })
})
