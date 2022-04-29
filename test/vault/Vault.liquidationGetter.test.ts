import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestAccountBalance,
    TestERC20,
    TestVault,
    UniswapV3Pool,
} from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { addOrder, q2bExactInput, syncIndexToMarketPrice } from "../helper/clearingHouseHelper"
import { initAndAddPool } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"

describe("Vault test", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: TestVault
    let usdc: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let wethPriceFeed: MockContract
    let wbtcPriceFeed: MockContract
    let clearingHouse: ClearingHouse
    let clearingHouseConfig: ClearingHouseConfig
    let insuranceFund: InsuranceFund
    let accountBalance: AccountBalance | TestAccountBalance
    let exchange: Exchange
    let orderBook: OrderBook
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedBaseAggregator: MockContract
    let usdcDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        const _fixture = await loadFixture(createClearingHouseFixture(true))
        vault = _fixture.vault as TestVault
        usdc = _fixture.USDC
        weth = _fixture.WETH
        wbtc = _fixture.WBTC
        wethPriceFeed = _fixture.mockedWethPriceFeed
        wbtcPriceFeed = _fixture.mockedWbtcPriceFeed
        clearingHouse = _fixture.clearingHouse
        clearingHouseConfig = _fixture.clearingHouseConfig
        insuranceFund = _fixture.insuranceFund
        accountBalance = _fixture.accountBalance
        exchange = _fixture.exchange
        orderBook = _fixture.orderBook
        pool = _fixture.pool
        baseToken = _fixture.baseToken
        marketRegistry = _fixture.marketRegistry
        mockedBaseAggregator = _fixture.mockedBaseAggregator
        fixture = _fixture

        usdcDecimals = await usdc.decimals()

        await initAndAddPool(
            fixture,
            pool,
            baseToken.address,
            encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
            10000,
            1000,
        )
        await syncIndexToMarketPrice(mockedBaseAggregator, pool)
        // set a higher price limit for large orders
        await exchange.setMaxTickCrossedWithinBlock(baseToken.address, "100000")

        // mint and add liquidity
        const amount = parseUnits("1000", usdcDecimals)
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)

        wethPriceFeed.smocked.getPrice.will.return.with(parseEther("3000"))
        wbtcPriceFeed.smocked.getPrice.will.return.with(parseEther("40000"))
        await weth.mint(alice.address, parseEther("1"))
        await weth.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await wbtc.mint(alice.address, parseUnits("1", await wbtc.decimals()))
        await wbtc.connect(alice).approve(vault.address, ethers.constants.MaxUint256)

        await usdc.mint(bob.address, parseUnits("1000000", usdcDecimals))
        await deposit(bob, vault, 1000000, usdc)
        await addOrder(fixture, bob, 500, 1000000, 0, 150000)
    })

    describe("# getMaxRepaidSettlementAndLiquidatableCollateral", async () => {
        beforeEach(async () => {
            await deposit(alice, vault, 1000, usdc)
            await deposit(alice, vault, 1, weth)
        })

        it("force error if the collateral token is not on the list", async () => {
            await expect(
                vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, usdc.address),
            ).to.be.revertedWith("V_TINAC")
        })

        // debt = 9000 (> collateralValueDust = 500), eth = 1, liquidation ratio = 0.5,
        // discount rate = 0.1, cl insurance rate = 0.03
        it("discounted collateral value less than max repay notional", async () => {
            await q2bExactInput(fixture, alice, 10000)
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0", 6), 0, 0, 0]
            })
            // maxRepaidSettlementX10_S = 1 * 2700 = 2700
            // maxLiquidatableCollateral = min(4500 (= 9000 * 0.5, cuz collateralValueDust = 500) / 0.97 / (3000 * 0.9), 1) = 1
            const result = await vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, weth.address)
            expect(result.maxRepaidSettlementX10_S).to.be.eq(parseUnits("2700", usdcDecimals))
            expect(result.maxLiquidatableCollateral).to.be.eq(parseEther("1"))
        })

        // debt = 500 (== collateralValueDust = 500), eth = 1, liquidation ratio = 0.5,
        // discount rate = 0.1, cl insurance rate = 0.03
        it("discounted collateral value greater than max repay notional", async () => {
            await q2bExactInput(fixture, alice, 1500)
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0", 6), 0, 0, 0]
            })
            // maxRepaidSettlementX10_S = 500  / 0.97 = 515.463917
            // maxLiquidatableCollateral = min(515.463917 / 2700, 1) = 0.1909125619
            const result = await vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, weth.address)
            expect(result.maxRepaidSettlementX10_S).to.be.eq(parseUnits("515.463917", usdcDecimals))
            expect(result.maxLiquidatableCollateral).to.be.eq(parseEther("0.190912561851851852"))
        })

        // debt = 500, eth = 1, liquidation ratio = 0.5,
        // discount rate = 0.1, cl insurance rate = 0.03
        it("return decimals should be same as the collateral token", async () => {
            await deposit(alice, vault, 1, wbtc)
            await q2bExactInput(fixture, alice, 1500)
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0", 6), 0, 0, 0]
            })
            // maxRepaidSettlementX10_S = 500 / 0.97 = 515.463917
            // maxLiquidatableCollateral = min(515.463917 / 36000, 1) = 0.01431844 -> 0.01431845 rounding up
            const result = await vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, wbtc.address)
            expect(result.maxRepaidSettlementX10_S).to.be.eq(parseUnits("515.463917", usdcDecimals))
            expect(result.maxLiquidatableCollateral).to.be.eq(parseUnits("0.01431845", await wbtc.decimals()))
        })
    })

    describe("# getRepaidSettlementByCollateral", async () => {
        it("return settlementX10_S of weth", async () => {
            // settlementX10_S = 0.333333333333333 * 3000 * 0.9 = 899.999999
            expect(await vault.getRepaidSettlementByCollateral(weth.address, parseEther("0.333333333333333"))).to.be.eq(
                parseUnits("899.999999", usdcDecimals),
            )
        })

        it("return settlementX10_S of wbtc", async () => {
            // settlementX10_S = 0.25252525 * 40000 * 0.9 = 9090.909
            expect(
                await vault.getRepaidSettlementByCollateral(
                    wbtc.address,
                    parseUnits("0.25252525", await wbtc.decimals()),
                ),
            ).to.be.eq(parseUnits("9090.909", usdcDecimals))
        })
    })

    describe("# getLiquidatableCollateralBySettlement", async () => {
        it("return collateral amount of weth", async () => {
            // collateral = 900 / (3000 * 0.9) = 0.333333333333333
            expect(
                await vault.getLiquidatableCollateralBySettlement(weth.address, parseUnits("900", usdcDecimals)),
            ).to.be.eq(parseEther("0.333333333333333334"))
        })

        it("return collateral amount of wbtc", async () => {
            // collateral = 9090.909 / (40000 * 0.9) = 0.25252525
            expect(
                await vault.getLiquidatableCollateralBySettlement(wbtc.address, parseUnits("9090.909", usdcDecimals)),
            ).to.be.eq(parseUnits("0.25252525", await wbtc.decimals()))
        })
    })

    describe("# _getMaxRepaidSettlement", async () => {
        beforeEach(async () => {
            await deposit(alice, vault, 1000, usdc)
            await deposit(alice, vault, 1, weth)
            // totalMarginRequirement = 4000 * 10% = 400
            await q2bExactInput(fixture, alice, 4000)
            // position size = 24.868218
        })

        // dust = 500
        describe("settlementTokenValue greater than 0", async () => {
            it("max debt less than collateral value dust", async () => {
                // 400 (< collateralValueDust = 500) / 0.97 = 412.371134
                expect(await vault.testGetMaxRepaidSettlement(alice.address)).to.be.eq(
                    parseUnits("412.371134", usdcDecimals),
                )
            })

            it("max debt larger than collateral value dust", async () => {
                await q2bExactInput(fixture, alice, 2000)
                // totalMarginRequirement = (4000 + 2000) * 10% = 600
                // 600 * 0.5 (> collateralValueDust = 500) / 0.97 = 309.27835052
                expect(await vault.testGetMaxRepaidSettlement(alice.address)).to.be.eq(
                    parseUnits("309.278350", usdcDecimals),
                )
            })
        })

        describe("settlementTokenValue less than 0", async () => {
            it("settlementTokenDebt greater than total margin requirement, max debt greater than collateral value dust", async () => {
                // settlementTokenValue = 1000 - 4000 = -3000
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("0", 6), 0, 0, 0]
                })
                // 1500 / 0.97 = 1546.39175258
                expect(await vault.testGetMaxRepaidSettlement(alice.address)).to.be.eq(
                    parseUnits("1546.391752", usdcDecimals),
                )
            })

            it("settlementTokenDebt less than total margin requirement, max debt less than collateral value dust", async () => {
                // settlementTokenValue = 1000 - (4000 - 24.868218 * 110) = -264.49602
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("110", 6), 0, 0, 0]
                })
                // 400 / 0.97 = 412.371134
                expect(await vault.testGetMaxRepaidSettlement(alice.address)).to.be.eq(
                    parseUnits("412.371134", usdcDecimals),
                )
            })
        })
    })
})
