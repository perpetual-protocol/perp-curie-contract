import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, TestClearingHouse, TestERC20, Vault } from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

// https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=238402888
describe("ClearingHouse slippage in xyk pool", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        const initPrice = "10"
        const { maxTick, minTick } = await initMarket(fixture, initPrice)
        await mockIndexPrice(mockedPriceFeedDispatcher, initPrice)

        lowerTick = minTick
        upperTick = maxTick

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await deposit(taker, vault, 1000, collateral)
    })

    describe("openPosition", () => {
        it("B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote", async () => {
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("2.5"),
                    oppositeAmountBound: parseEther("200"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_TLRS")
        })

        it("B2Q + exact output, want less input base as possible, so we set a upper bound of input base", async () => {
            // taker swap exact 25 USD for expected 2.5 ETH but got less
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    amount: parseEther("25"),
                    oppositeAmountBound: parseEther("2.5"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_TMRS")
        })

        it("Q2B + exact input, want more output base as possible, so we set a lower bound of output base", async () => {
            // taker swap exact 25 USD for expected 20 ETH but got less
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    amount: parseEther("25"),
                    oppositeAmountBound: parseEther("20"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_TLRL")
        })

        it("Q2B + exact output want less input quote as possible, so we set a upper bound of input quote", async () => {
            // taker swap exact 2.5 USD for expected 2 ETH but got less
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: parseEther("2"),
                    oppositeAmountBound: parseEther("2.5"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_TMRL")
        })
    })

    describe("closePosition", () => {
        it("open short then close", async () => {
            // taker shorts 2.5 ETH with roughly 24 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("2.5"),
                oppositeAmountBound: 0,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // taker wants to close 2.5 ETH short for 24 USD but get less bcs of the tx fee
            await expect(
                clearingHouse.connect(taker).closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: 0,
                    oppositeAmountBound: parseEther("24"),
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_TMRL")
        })

        it("open long then close", async () => {
            // taker longs for roughly 2.4 ETH with 25 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("25"),
                oppositeAmountBound: 0,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // taker wants to close 2.4 ETH long for 25 USD but get less bcs of the tx fee
            await expect(
                clearingHouse.connect(taker).closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: 0,
                    oppositeAmountBound: parseEther("25"),
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_TLRS")
        })
    })
})
