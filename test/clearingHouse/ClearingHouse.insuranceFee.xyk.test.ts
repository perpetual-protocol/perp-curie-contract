import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    InsuranceFund,
    MarketRegistry,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse insurance fee in xyk pool", () => {
    const [admin, maker1, maker2, taker1, taker2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: ClearingHouse
    let marketRegistry: MarketRegistry
    let accountBalance: AccountBalance
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse
        accountBalance = fixture.accountBalance
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        insuranceFund = fixture.insuranceFund
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        pool = fixture.pool
        collateralDecimals = await collateral.decimals()

        const initPrice = "10"
        const { maxTick, minTick } = await initMarket(fixture, initPrice, undefined, 400000)
        await mockIndexPrice(mockedPriceFeedDispatcher, initPrice)

        lowerTick = minTick
        upperTick = maxTick

        // prepare collateral for maker1
        await collateral.mint(maker1.address, parseUnits("1000", collateralDecimals))
        await deposit(maker1, vault, 1000, collateral)
        await clearingHouse.connect(maker1).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("90"),
            quote: parseEther("900"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for maker2
        await collateral.mint(maker2.address, parseUnits("1000", collateralDecimals))
        await deposit(maker2, vault, 1000, collateral)
        await clearingHouse.connect(maker2).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("10"),
            quote: parseEther("100"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker1 and taker 2
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker1.address, takerCollateral)
        await collateral.connect(taker1).approve(clearingHouse.address, takerCollateral)
        await deposit(taker1, vault, 1000, collateral)

        await collateral.mint(taker2.address, takerCollateral)
        await collateral.connect(taker2).approve(clearingHouse.address, takerCollateral)
        await deposit(taker2, vault, 1000, collateral)
    })

    // https://docs.google.com/spreadsheets/d/1cAldl4tb4HcnyEkxnSEnjXWYrWjt4bw2L2kstasN3VA/edit?usp=sharing
    describe("quote to base: 25Q => 2.415223225176872407B, maker get fee", () => {
        it("exact input 25Q", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        it("exact output 2.415223225176872407B", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("2.415223225176872407"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        afterEach(async () => {
            const resp1 = await clearingHouse.connect(maker1).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            // maker fee = swapped quote * ClearingHouseFeeRatio * (100% - InsuranceFundFeeRatio) * (maker's liquidity / total liquidity within the range)
            // 25 * 1% * 60% * 90% = 0.135
            expect(resp1.fee).eq(parseEther("0.135"))

            const resp2 = await clearingHouse.connect(maker2).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            // 25 * 1% * 60% * 10% ~= 0.015
            expect(resp2.fee).eq(parseEther("0.014999999999999999"))

            const [owedRealizedPnl] = await accountBalance.getPnlAndPendingFee(insuranceFund.address)
            // 25 * 1% * 40% ~= 0.1
            expect(owedRealizedPnl).eq(parseEther("0.1"))
        })
    })

    describe("base to quote: 2.5B => 24.146341463414634146Q, maker get fee", () => {
        it("exact input 2.5B", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("2.5"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        it("exact output 24.146341463414634146Q", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("24.146341463414634146"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        afterEach(async () => {
            const resp1 = await clearingHouse.connect(maker1).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            // 24.3902439024 * 1% * 60% * 90% = 0.1317073171
            expect(resp1.fee).eq(parseEther("0.131707317073170731"))

            const resp2 = await clearingHouse.connect(maker2).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            // 24.3902439024 * 1% * 60% * 10% ~= 0.01463414634
            expect(resp2.fee).eq(parseEther("0.014634146341463414"))

            const [owedRealizedPnl] = await accountBalance.getPnlAndPendingFee(insuranceFund.address)
            // 24.3902439024 * 1% * 40% ~= 0.09756097561
            expect(owedRealizedPnl).eq(parseEther("0.097560975609756098"))
        })
    })
})
