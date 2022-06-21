import { MockContract, smockit } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    CollateralManager,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestAccountBalance,
    TestERC20,
    TestVault,
    UniswapV3Pool,
} from "../../typechain"
import { ChainlinkPriceFeedV2 } from "../../typechain/perp-oracle"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import {
    addOrder,
    b2qExactOutput,
    closePosition,
    q2bExactInput,
    syncIndexToMarketPrice,
} from "../helper/clearingHouseHelper"
import { initAndAddPool } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"

describe("Vault test", () => {
    const [admin, alice, bob, carol, david] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: TestVault
    let usdc: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let wethPriceFeed: MockContract
    let wbtcPriceFeed: MockContract
    let insuranceFund: InsuranceFund
    let accountBalance: AccountBalance | TestAccountBalance
    let exchange: Exchange
    let orderBook: OrderBook
    let collateralManager: CollateralManager
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedBaseAggregator: MockContract
    let usdcDecimals: number
    let wbtcDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        const _fixture = await loadFixture(createClearingHouseFixture(true))
        vault = _fixture.vault as TestVault
        usdc = _fixture.USDC
        weth = _fixture.WETH
        wbtc = _fixture.WBTC
        wethPriceFeed = _fixture.mockedWethPriceFeed
        wbtcPriceFeed = _fixture.mockedWbtcPriceFeed
        insuranceFund = _fixture.insuranceFund
        accountBalance = _fixture.accountBalance
        exchange = _fixture.exchange
        orderBook = _fixture.orderBook
        collateralManager = _fixture.collateralManager
        pool = _fixture.pool
        baseToken = _fixture.baseToken
        marketRegistry = _fixture.marketRegistry
        mockedBaseAggregator = _fixture.mockedBaseAggregator
        fixture = _fixture

        usdcDecimals = await usdc.decimals()
        wbtcDecimals = await wbtc.decimals()

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
        wbtcPriceFeed.smocked.getPrice.will.return.with(parseEther("38583.342533243141353154"))
        await weth.mint(alice.address, parseEther("20"))
        await weth.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await wbtc.mint(alice.address, parseUnits("1", await wbtc.decimals()))
        await wbtc.connect(alice).approve(vault.address, ethers.constants.MaxUint256)

        await usdc.mint(bob.address, parseUnits("1000000", usdcDecimals))
        await deposit(bob, vault, 1000000, usdc)
        await addOrder(fixture, bob, 500, 1000000, 0, 150000)

        // Carol will liquidate Alice's position
        const usdcAmount = parseUnits("10000", usdcDecimals)
        await usdc.mint(carol.address, usdcAmount)
        await usdc.connect(carol).approve(vault.address, usdcAmount)
    })

    describe("# isLiquidatable", async () => {
        describe("trader has position", async () => {
            beforeEach(async () => {
                await deposit(alice, vault, 1000, usdc)
                // position size: 18.88437579
                await q2bExactInput(fixture, alice, 3000)
            })

            it("trader doesn't have usdc debt and margin ratio is above 6.45%", async () => {
                await deposit(alice, vault, 1, weth)
                expect(await vault.isLiquidatable(alice.address)).to.be.false
            })

            describe("collateral margin ratio below 6.45% (6.25% mmRatio + 0.2% mmRatioBuffer)", async () => {
                it("trader is not liquidatable when he/she doesn't have collateral token", async () => {
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("116", 6), 0, 0, 0]
                    })
                    // account value: 1000 + (18.88437579 * 116 - 3000) = 190.58759164
                    expect(await vault.getAccountValue(alice.address)).to.be.eq(parseUnits("190.587592", usdcDecimals))
                    // margin ratio: 190.58759164 / 3000 = 0.0635292
                    expect(await vault.isLiquidatable(alice.address)).to.be.false
                })

                it("trader doesn't have usdc debt", async () => {
                    await deposit(alice, vault, 0.01, weth)
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("110", 6), 0, 0, 0]
                    })
                    // usdc value: 1000 + (18.88437579 * 110 - 3000) = 77.2813369 > 0
                    expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                        parseUnits("77.281337", usdcDecimals),
                    )
                    // account value: 1000 + 0.01 * 3000 * 0.7 + (18.88437579 * 110 - 3000) = 98.2813369
                    expect(await vault.getAccountValue(alice.address)).to.be.eq(parseUnits("98.281337", usdcDecimals))
                    // 6.45% collateral margin requirement: 18.88437579 * 110 * 0.0645 = 133.98464623
                    // margin ratio: 98.2813369 / 3000 = 0.03276045
                    expect(await vault.isLiquidatable(alice.address)).to.be.true
                })

                it("trader has usdc debt", async () => {
                    await deposit(alice, vault, 0.4, weth)
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("65", 6), 0, 0, 0]
                    })
                    // usdc value: 1000 + (18.88437579 * 65 - 3000) = -772.51557365 < 0
                    expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                        parseUnits("-772.515573", usdcDecimals),
                    )
                    // account value: 1000 + 0.4 * 3000 * 0.7 + -1,772.515573 (18.88437579 * 65 - 3000) = 67.484427
                    expect(await vault.getAccountValue(alice.address)).to.be.eq(parseUnits("67.484427", usdcDecimals))
                    // 6.45% collateral margin requirement: 18.88437579 * 65 * 0.0645 = 79.1727455
                    // margin ratio: 67.48442635 / 3000 = 0.02249481
                    expect(await vault.isLiquidatable(alice.address)).to.be.true
                })
            })

            it("usdc debt is greater than the non-settlement token value multiply the debt ratio", async () => {
                await deposit(alice, vault, 0.7, weth)
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("40", 6), 0, 0, 0]
                })
                // usdc debt: 1000 + (18.88437579 * 40 - 3000) = -1244.6249684
                // non-settlement token value: 0.7 * 3000 * 0.7 = 1470
                // account value: 1000 + 0.7 * 3000 * 0.7 + (18.88437579 * 40 - 3000) = 225.3750316
                // 6.45% collateral margin requirement: 18.88437579 * 70 * 0.0645 = 85.26295669
                // margin ratio: 225.3750316 / 3000 = 0.07512501
                // usdc debt > non-settlement token value * 0.75: 1244.6249684 > 1470 * 0.75
                const accountValue = await vault.getAccountValue(alice.address)
                const mmMarginRequirement = await vault.getMarginRequirementForCollateralLiquidation(alice.address)
                expect(accountValue.mul(10 ** 12)).to.be.gt(mmMarginRequirement)
                expect(await vault.isLiquidatable(alice.address)).to.be.true
            })

            it("usdc debt is greater than the debt threshold", async () => {
                await deposit(alice, vault, 20, weth)
                await q2bExactInput(fixture, alice, 27000)
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("75", 6), 0, 0, 0]
                })
                // position size: 141.180531
                // usdc debt: 1000 + (141.180531 * 75 - 30000) = -18411.460175
                // account value: 1000 + 20 * 3000 * 0.7 + (141.180531 * 75 - 30000) = 23588.539825
                // 6.45% collateral margin requirement: 141.180531 * 70 * 0.0645 = 637.43009746
                // margin ratio : 23588.539825 / 30000 = 0.78628466
                const accountValue = await vault.getAccountValue(alice.address)
                const mmMarginRequirement = await vault.getMarginRequirementForCollateralLiquidation(alice.address)
                expect(accountValue.mul(10 ** 12)).to.be.gt(mmMarginRequirement)

                // usdc debt < non-settlement token value * 0.75: 18411.460175 < 42000 * 0.75
                const settlementTokenDebt = await vault.getSettlementTokenValue(alice.address)
                expect(settlementTokenDebt).to.be.eq(parseUnits("-18411.460174", usdcDecimals))
                expect(settlementTokenDebt.abs()).to.be.lt(parseUnits("42000", usdcDecimals).mul(75).div(100))

                // usdc debt > debt threshold: 18411.460175 > 10000, thus still liquidatable
                expect(await vault.isLiquidatable(alice.address)).to.be.true
            })
        })

        describe("trader has no position", async () => {
            beforeEach(async () => {
                await deposit(alice, vault, 1, weth)
                await deposit(alice, vault, 0.1, wbtc)
            })

            it("trader has no debt", async () => {
                expect(await vault.isLiquidatable(alice.address)).to.be.false
            })

            it("trader has usdc debt and not liquidatable, then becomes liquidatable after weth/wbtc price drops", async () => {
                await q2bExactInput(fixture, alice, 3000)
                await b2qExactOutput(fixture, bob, 3000)
                // alice close position and has negative pnl: -276.55275771
                await closePosition(fixture, alice)
                expect(await vault.isLiquidatable(alice.address)).to.be.false

                wethPriceFeed.smocked.getPrice.will.return.with(parseEther("200"))
                wbtcPriceFeed.smocked.getPrice.will.return.with(parseUnits("2000"))
                // non-settlement token value: (1 * 200 * 0.7) + (0.1 * 2000 * 0.7) = 280
                // debt > non-settlement token value * 0.75: 276.55275771 > 280 * 0.75
                expect(await vault.isLiquidatable(alice.address)).to.be.true
            })

            it("trader is liquidatable when usdc debt greater than debt threshold", async () => {
                await deposit(alice, vault, 10, weth)
                await q2bExactInput(fixture, alice, 10000)
                await b2qExactOutput(fixture, bob, 20000)
                // alice's total realized pnl: -4099.33124393
                await closePosition(fixture, alice)

                expect(await vault.isLiquidatable(alice.address)).to.be.false

                await q2bExactInput(fixture, alice, 15000)
                await b2qExactOutput(fixture, bob, 25000)
                // alice's total realized pnl: -12185.86442144
                await closePosition(fixture, alice)

                // cuz index price hasn't changed yet, have to close the position to realize the loss
                // to make the collateral liquidatable
                expect(await vault.isLiquidatable(alice.address)).to.be.true
            })
        })
    })

    describe("liquidate collateral", async () => {
        let xxx: TestERC20
        const xxxDecimals = 4
        beforeEach(async () => {
            // xxx is a test collateral token with 4 decimals, which is less than usdc's decimals
            const tokenFactory = await ethers.getContractFactory("TestERC20")
            xxx = (await tokenFactory.deploy()) as TestERC20
            await xxx.__TestERC20_init("TestXXXToken", "XXX", xxxDecimals)

            // setup xxx price feed
            const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
            const aggregator = await aggregatorFactory.deploy()
            const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeedV2")
            const xxxPriceFeed = (await chainlinkPriceFeedFactory.deploy(aggregator.address, 0)) as ChainlinkPriceFeedV2
            const mockedXxxPriceFeed = await smockit(xxxPriceFeed)

            // set xxx oracle price with 18 decimals
            mockedXxxPriceFeed.smocked.getPrice.will.return.with(parseEther("101.123456789012345678"))
            mockedXxxPriceFeed.smocked.decimals.will.return.with(18)

            // add xxx token as collateral
            await collateralManager.addCollateral(xxx.address, {
                priceFeed: mockedXxxPriceFeed.address,
                collateralRatio: (0.7e6).toString(),
                discountRatio: (0.1e6).toString(),
                depositCap: parseEther("1000"),
            })

            // mint xxx for alice
            await xxx.mint(alice.address, parseUnits("5", xxxDecimals))
            await xxx.connect(alice).approve(vault.address, ethers.constants.MaxUint256)

            await deposit(alice, vault, 1, weth)
            await deposit(alice, vault, 0.02355323, wbtc)
            await deposit(alice, vault, 1.1237, xxx)
            await q2bExactInput(fixture, alice, 5000)
        })

        it("force error, not liquidatable", async () => {
            await expect(
                vault.liquidateCollateral(alice.address, weth.address, parseUnits("100", usdcDecimals), true),
            ).to.be.revertedWith("V_NL")

            await expect(
                vault.liquidateCollateral(alice.address, weth.address, parseEther("0.1"), false),
            ).to.be.revertedWith("V_NL")
        })

        it("force error, liquidator doesn't have enough settlement token for liquidation", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0", 6), 0, 0, 0]
            })
            await expect(
                vault
                    .connect(david)
                    .liquidateCollateral(alice.address, weth.address, parseUnits("1", usdcDecimals), true),
            ).to.be.revertedWith("revert ERC20: transfer amount exceeds balance")
            await expect(
                vault.connect(david).liquidateCollateral(alice.address, weth.address, parseEther("0.01"), false),
            ).to.be.revertedWith("revert ERC20: transfer amount exceeds balance")
        })

        describe("# liquidateCollateral by settlement token", async () => {
            beforeEach(async () => {
                // usdc debt: 5000
                // max liquidatable value: 2577.319587
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("0", 6), 0, 0, 0]
                })
            })

            it("force error, cannot liquidate more than max liquidatable settlement amount", async () => {
                await expect(
                    vault.liquidateCollateral(alice.address, weth.address, parseUnits("5000", usdcDecimals), true),
                ).to.be.revertedWith("V_MSAE")
            })

            it("liquidate trader's weth by using 1000 usdc", async () => {
                const vaultWethBalanceBefore = await weth.balanceOf(vault.address)
                const vaultUsdcBalanceBefore = await usdc.balanceOf(vault.address)

                // liquidate alice's weth with 1000 usdc
                const tx = await vault
                    .connect(carol)
                    .liquidateCollateral(alice.address, weth.address, parseUnits("1000", usdcDecimals), true)

                // liquidated collateral: 1000 / (3000 * 0.9) = 0.37037037
                const liquidatedAmount = parseEther("0.370370370370370371")

                // events checking
                await expect(tx).to.emit(vault, "CollateralLiquidated").withArgs(
                    alice.address,
                    weth.address,
                    carol.address,
                    liquidatedAmount,
                    parseUnits("970", usdcDecimals), // repaid amount: 1000 * (1 - 0.03) = 970
                    parseUnits("30", usdcDecimals), // collateral liquidation insurance fund fee: 1000 - 970 = 30
                    100000,
                )
                await expect(tx).to.emit(weth, "Transfer").withArgs(vault.address, carol.address, liquidatedAmount)
                await expect(tx)
                    .to.emit(usdc, "Transfer")
                    .withArgs(carol.address, vault.address, parseUnits("1000", usdcDecimals))

                // carol's usdc balance: 10000 - 1000 = 9000
                expect(await usdc.balanceOf(carol.address)).to.be.eq(parseUnits("9000", usdcDecimals))
                // weth amount: 1000 / (3000 * 0.9) = 0.37037037
                expect(await weth.balanceOf(carol.address)).to.be.eq(liquidatedAmount)

                // repaid amount: 1000 * (1 - 0.03) = 970
                // alice's usdc debt = 5000 - 970 = 4030
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(parseUnits("-4030", usdcDecimals))
                // alice's weth balance: 1 - 0.370370370370370371 = 0.62962963
                expect(await vault.getBalanceByToken(alice.address, weth.address)).to.be.eq(
                    parseEther("1").sub(liquidatedAmount),
                )
                // alice's usdc balance: 970
                expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("970", usdcDecimals))

                // collateral liquidation insurance fund fee: 1000 * 0.03 = 30
                expect(await vault.getBalance(insuranceFund.address)).to.be.eq(parseUnits("30", usdcDecimals))

                // vault's balance
                expect(await weth.balanceOf(vault.address)).to.be.eq(vaultWethBalanceBefore.sub(liquidatedAmount))
                expect(await usdc.balanceOf(vault.address)).to.be.eq(
                    vaultUsdcBalanceBefore.add(parseUnits("1000", usdcDecimals)),
                )

                expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([
                    weth.address,
                    wbtc.address,
                    xxx.address,
                ])
            })

            it("liquidate alice's weth with maximum usdc amount", async () => {
                const vaultWethBalanceBefore = await weth.balanceOf(vault.address)
                const vaultUsdcBalanceBefore = await usdc.balanceOf(vault.address)

                // max liquidatable value of weth: 2577.319587
                const maxRepaidSettlement = (
                    await vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, weth.address)
                ).maxRepaidSettlementX10_S

                const tx = await vault
                    .connect(carol)
                    .liquidateCollateral(alice.address, weth.address, maxRepaidSettlement, true)

                // liquidated collateral: 2577.319587 / (3000 * 0.9) = 0.95456281
                const liquidatedAmount = parseEther("0.95456281")

                // events checking
                await expect(tx).to.emit(vault, "CollateralLiquidated").withArgs(
                    alice.address,
                    weth.address,
                    carol.address,
                    liquidatedAmount,
                    parseUnits("2499.999999", usdcDecimals), // repaid amount: 2577.319587 * (1 - 0.03) = 2499.99999939
                    parseUnits("77.319588", usdcDecimals), // collateral liquidation insurance fund fee: 2577.319587 - 2499.999999 = 77.319588
                    100000,
                )
                await expect(tx).to.emit(weth, "Transfer").withArgs(vault.address, carol.address, liquidatedAmount)
                await expect(tx)
                    .to.emit(usdc, "Transfer")
                    .withArgs(carol.address, vault.address, parseUnits("2577.319587", usdcDecimals))

                // carol's usdc balance: 10000 - 2577.319587 = 7422.680413
                expect(await usdc.balanceOf(carol.address)).to.be.eq(parseUnits("7422.680413", usdcDecimals))
                expect(await weth.balanceOf(carol.address)).to.be.eq(liquidatedAmount)

                // repaid amount: 2577.319587 * (1 - 0.03) = 2499.99999939
                // alice's usdc debt = 5000 - 2499.999999 = 2500.000001
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("-2500.000001", usdcDecimals),
                )
                // alice's weth balance: 1 - 0.95456281 = 0.04543719
                expect(await vault.getBalanceByToken(alice.address, weth.address)).to.be.eq(
                    parseEther("1").sub(liquidatedAmount),
                )
                // alice's usdc balance: 2499.999999
                expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("2499.999999", usdcDecimals))

                // collateral liquidation insurance fund fee: 2577.319587 * 0.03 = 77.319588
                expect(await vault.getBalance(insuranceFund.address)).to.be.eq(parseUnits("77.319588", usdcDecimals))

                // vault's balance
                expect(await weth.balanceOf(vault.address)).to.be.eq(vaultWethBalanceBefore.sub(liquidatedAmount))
                expect(await usdc.balanceOf(vault.address)).to.be.eq(
                    vaultUsdcBalanceBefore.add(parseUnits("2577.319587", usdcDecimals)),
                )

                expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([
                    weth.address,
                    wbtc.address,
                    xxx.address,
                ])
            })

            it("liquidate alice's wbtc with maximum usdc amount", async () => {
                const vaultWbtcBalanceBefore = await wbtc.balanceOf(vault.address)
                const vaultUsdcBalanceBefore = await usdc.balanceOf(vault.address)

                // max liquidatable value of wbtc: 817.886106 / 38583.342533243141353154
                const maxRepaidSettlement = (
                    await vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, wbtc.address)
                ).maxRepaidSettlementX10_S

                const tx = await vault
                    .connect(carol)
                    .liquidateCollateral(alice.address, wbtc.address, maxRepaidSettlement, true)

                // liquidated collateral: 817.886106 / (38583.342533243141353154 * 0.9) = 0.02355322998
                const liquidatedAmount = parseUnits("0.02355323", wbtcDecimals)

                // events checking
                await expect(tx).to.emit(vault, "CollateralLiquidated").withArgs(
                    alice.address,
                    wbtc.address,
                    carol.address,
                    liquidatedAmount,
                    parseUnits("793.349522", usdcDecimals), // repaid amount: 817.886106 * (1 - 0.03) = 793.349522
                    parseUnits("24.536584", usdcDecimals), // collateral liquidation insurance fund fee: 817.886106 - 793.349522 = 24.536584
                    100000,
                )
                await expect(tx).to.emit(wbtc, "Transfer").withArgs(vault.address, carol.address, liquidatedAmount)
                await expect(tx)
                    .to.emit(usdc, "Transfer")
                    .withArgs(carol.address, vault.address, parseUnits("817.886106", usdcDecimals))

                // carol's usdc balance: 10000 - 817.886106 = 9182.113894
                expect(await usdc.balanceOf(carol.address)).to.be.eq(parseUnits("9182.113894", usdcDecimals))
                // wbtc amount: 817.886106 / (38583.342533 * 0.9) = 0.02355323
                expect(await wbtc.balanceOf(carol.address)).to.be.eq(liquidatedAmount)

                // repaid amount: 817.886106 * (1 - 0.03) = 793.349522
                // alice's usdc debt = 5000 - 793.349522 = 4206.650478
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("-4206.650478", usdcDecimals),
                )
                // alice's wbtc balance: 0.02355323 - 0.02355323 = 0
                expect(await vault.getBalanceByToken(alice.address, wbtc.address)).to.be.eq(
                    parseUnits("0", wbtcDecimals),
                )
                // alice's usdc balance: 793.349522
                expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("793.349522", usdcDecimals))

                // collateral liquidation insurance fund fee: 817.886106 * 0.03 = 24.536584
                expect(await vault.getBalance(insuranceFund.address)).to.be.eq(parseUnits("24.536584", usdcDecimals))

                // vault's balance
                expect(await wbtc.balanceOf(vault.address)).to.be.eq(vaultWbtcBalanceBefore.sub(liquidatedAmount))
                expect(await usdc.balanceOf(vault.address)).to.be.eq(
                    vaultUsdcBalanceBefore.add(parseUnits("817.886106", usdcDecimals)),
                )

                // deregister wbtc collateral
                expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([weth.address, xxx.address])
            })

            it("liquidate alice's xxx token, which has lesser decimals than settlement token", async () => {
                const vaultXxxBalanceBefore = await xxx.balanceOf(vault.address)
                const vaultUsdcBalanceBefore = await usdc.balanceOf(vault.address)

                // max liquidatable value of xxx: 102.269185
                const maxRepaidSettlement = (
                    await vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, xxx.address)
                ).maxRepaidSettlementX10_S

                const tx = await vault
                    .connect(carol)
                    .liquidateCollateral(alice.address, xxx.address, maxRepaidSettlement, true)

                // liquidated collateral: 102.269185 / (101.123456789012345678 * 0.9) = 1.1236999939
                const liquidatedAmount = parseUnits("1.1237", xxxDecimals)

                // events checking
                await expect(tx).to.emit(vault, "CollateralLiquidated").withArgs(
                    alice.address,
                    xxx.address,
                    carol.address,
                    liquidatedAmount,
                    parseUnits("99.201109", usdcDecimals), // repaid amount: 102.269185 * (1 - 0.03) = 99.201109
                    parseUnits("3.068076", usdcDecimals), // collateral liquidation insurance fund fee: 102.269185 - 99.201109 = 3.068076
                    100000,
                )
                await expect(tx).to.emit(xxx, "Transfer").withArgs(vault.address, carol.address, liquidatedAmount)
                await expect(tx)
                    .to.emit(usdc, "Transfer")
                    .withArgs(carol.address, vault.address, parseUnits("102.269185", usdcDecimals))

                // carol's usdc balance: 10000 - 102.269185 = 9897.730815
                expect(await usdc.balanceOf(carol.address)).to.be.eq(parseUnits("9897.730815", usdcDecimals))
                // xxx amount: 102.269185 / (101.123456789012345678 * 0.9) = 1.1237
                expect(await xxx.balanceOf(carol.address)).to.be.eq(liquidatedAmount)

                // repaid amount: 102.269185 * (1 - 0.03) = 99.201109
                // alice's usdc debt = 5000 - 99.201109 = 4900.798891
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("-4900.798891", usdcDecimals),
                )
                // alice's xxx balance: 1.1237 - 1.1237 = 0
                expect(await vault.getBalanceByToken(alice.address, xxx.address)).to.be.eq(parseUnits("0", xxxDecimals))
                // alice's usdc balance: 99.201109
                expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("99.201109", usdcDecimals))

                // collateral liquidation insurance fund fee: 102.269185 * 0.03 = 3.068076
                expect(await vault.getBalance(insuranceFund.address)).to.be.eq(parseUnits("3.068076", usdcDecimals))

                // vault's balance
                expect(await xxx.balanceOf(vault.address)).to.be.eq(vaultXxxBalanceBefore.sub(liquidatedAmount))
                expect(await usdc.balanceOf(vault.address)).to.be.eq(
                    vaultUsdcBalanceBefore.add(parseUnits("102.269185", usdcDecimals)),
                )

                // deregister alice's xxx collateral
                expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([weth.address, wbtc.address])
            })
        })

        describe("# liquidateCollateral by non-settlement token", async () => {
            beforeEach(async () => {
                // usdc debt: 5000
                // max liquidatable amount: 0.954562
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("0", 6), 0, 0, 0]
                })
            })

            it("force error, cannot liquidate more than max liquidatable non-settlement amount", async () => {
                await expect(
                    vault.liquidateCollateral(alice.address, weth.address, parseEther("1"), false),
                ).to.be.revertedWith("V_MCAE")
            })

            it("liquidate trader's weth with amount of 0.5", async () => {
                const vaultWethBalanceBefore = await weth.balanceOf(vault.address)
                const vaultUsdcBalanceBefore = await usdc.balanceOf(vault.address)

                const liquidatedAmount = parseEther("0.5")
                // liquidate alice's weth with amount: 0.5
                const tx = await vault
                    .connect(carol)
                    .liquidateCollateral(alice.address, weth.address, parseEther("0.5"), false)

                // events checking
                await expect(tx).to.emit(vault, "CollateralLiquidated").withArgs(
                    alice.address,
                    weth.address,
                    carol.address,
                    liquidatedAmount, // collateral amount
                    parseUnits("1309.5", usdcDecimals), // repaid amount: 0.5 * 3000 * 0.9 * (1 - 0.03) = 1309.5
                    parseUnits("40.5", usdcDecimals), // collateral liquidation insurance fund fee: 0.5 * 3000 * 0.9 - 1309.5 = 40.5
                    100000,
                )
                await expect(tx).to.emit(weth, "Transfer").withArgs(vault.address, carol.address, liquidatedAmount)
                await expect(tx)
                    .to.emit(usdc, "Transfer")
                    .withArgs(carol.address, vault.address, parseUnits("1350", usdcDecimals))

                // carol's usdc balance: 10000 - 1350 = 8650
                expect(await usdc.balanceOf(carol.address)).to.be.eq(parseUnits("8650", usdcDecimals))
                expect(await weth.balanceOf(carol.address)).to.be.eq(liquidatedAmount)

                // repaid amount: 1350 * (1 - 0.03) = 1309.5
                // alice's usdc debt = 5000 - 1309.5 = 3690.5
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(parseUnits("-3690.5", usdcDecimals))
                // alice's weth balance: 1 - 0.5 = 0.5
                expect(await vault.getBalanceByToken(alice.address, weth.address)).to.be.eq(
                    parseEther("1").sub(liquidatedAmount),
                )
                // alice's usdc balance: 1309.5
                expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("1309.5", usdcDecimals))

                // collateral liquidation insurance fund fee: 1350 * 0.03 = 40.5
                expect(await vault.getBalance(insuranceFund.address)).to.be.eq(parseUnits("40.5", usdcDecimals))

                // vault's balance
                expect(await weth.balanceOf(vault.address)).to.be.eq(vaultWethBalanceBefore.sub(liquidatedAmount))
                expect(await usdc.balanceOf(vault.address)).to.be.eq(
                    vaultUsdcBalanceBefore.add(parseUnits("1350", usdcDecimals)),
                )

                expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([
                    weth.address,
                    wbtc.address,
                    xxx.address,
                ])
            })

            it("liquidate alice's weth with maximum amount", async () => {
                const vaultWethBalanceBefore = await weth.balanceOf(vault.address)
                const vaultUsdcBalanceBefore = await usdc.balanceOf(vault.address)

                // max liquidatable amount: 0.95456281
                const maxLiquidatableCollateral = (
                    await vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, weth.address)
                ).maxLiquidatableCollateral

                const tx = await vault
                    .connect(carol)
                    .liquidateCollateral(alice.address, weth.address, maxLiquidatableCollateral, false)

                // events checking
                await expect(tx).to.emit(vault, "CollateralLiquidated").withArgs(
                    alice.address,
                    weth.address,
                    carol.address,
                    maxLiquidatableCollateral, // collateral amount
                    parseUnits("2499.999999", usdcDecimals), // repaid amount: 0.95456281 * 3000 * 0.9 * (1 - 0.03) = 2499.99999939
                    parseUnits("77.319588", usdcDecimals), // collateral liquidation insurance fund fee: 0.95456281 * 3000 * 0.9 - 2499.99999939 = 77.31958761
                    100000,
                )
                await expect(tx)
                    .to.emit(weth, "Transfer")
                    .withArgs(vault.address, carol.address, maxLiquidatableCollateral)

                // settlement amount: 2499.999999 + 77.319588 = 2577.319587
                await expect(tx)
                    .to.emit(usdc, "Transfer")
                    .withArgs(carol.address, vault.address, parseUnits("2577.319587", usdcDecimals))

                // carol's usdc balance: 10000 - 2577.319587 = 7422.680413
                expect(await usdc.balanceOf(carol.address)).to.be.eq(parseUnits("7422.680413", usdcDecimals))
                expect(await weth.balanceOf(carol.address)).to.be.eq(maxLiquidatableCollateral)

                // repaid amount: 2577.319587 * (1 - 0.03) = 2499.99999939
                // alice's usdc debt = 5000 - 2499.999999 = 2500.000001
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("-2500.000001", usdcDecimals),
                )
                // alice's weth balance: 1 - 0.95456281 = 0.04543719
                expect(await vault.getBalanceByToken(alice.address, weth.address)).to.be.eq(
                    parseEther("1").sub(maxLiquidatableCollateral),
                )
                // alice's usdc balance: 2499.99999939
                expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("2499.999999", usdcDecimals))

                // collateral liquidation insurance fund fee: 2577.319587 - 2499.999999 = 77.319588
                expect(await vault.getBalance(insuranceFund.address)).to.be.eq(parseUnits("77.319588", usdcDecimals))

                // vault's balance
                expect(await weth.balanceOf(vault.address)).to.be.eq(
                    vaultWethBalanceBefore.sub(maxLiquidatableCollateral),
                )
                expect(await usdc.balanceOf(vault.address)).to.be.eq(
                    vaultUsdcBalanceBefore.add(parseUnits("2577.319587", usdcDecimals)),
                )

                expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([
                    weth.address,
                    wbtc.address,
                    xxx.address,
                ])
            })

            it("liquidate alice's wbtc with maximum amount", async () => {
                const vaultWbtcBalanceBefore = await wbtc.balanceOf(vault.address)
                const vaultUsdcBalanceBefore = await usdc.balanceOf(vault.address)

                // max liquidatable amount of wbtc: 0.02355323
                const maxLiquidatableCollateral = (
                    await vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, wbtc.address)
                ).maxLiquidatableCollateral

                const tx = await vault
                    .connect(carol)
                    .liquidateCollateral(alice.address, wbtc.address, maxLiquidatableCollateral, false)

                // events checking
                await expect(tx).to.emit(vault, "CollateralLiquidated").withArgs(
                    alice.address,
                    wbtc.address,
                    carol.address,
                    maxLiquidatableCollateral,
                    parseUnits("793.349522", usdcDecimals), // repaid amount: 817.886106 * (1 - 0.03) = 793.349522
                    parseUnits("24.536584", usdcDecimals), // collateral liquidation insurance fund fee: 817.886106 - 793.349522 = 24.536584
                    100000,
                )
                await expect(tx)
                    .to.emit(wbtc, "Transfer")
                    .withArgs(vault.address, carol.address, maxLiquidatableCollateral)
                await expect(tx)
                    .to.emit(usdc, "Transfer")
                    .withArgs(carol.address, vault.address, parseUnits("817.886106", usdcDecimals))

                // carol's usdc balance: 10000 - 817.886106 = 9182.113894
                expect(await usdc.balanceOf(carol.address)).to.be.eq(parseUnits("9182.113894", usdcDecimals))
                // wbtc amount: 817.886106 / (38583.342533 * 0.9) = 0.02355323
                expect(await wbtc.balanceOf(carol.address)).to.be.eq(maxLiquidatableCollateral)

                // repaid amount: 817.886106 * (1 - 0.03) = 793.349522
                // alice's usdc debt = 5000 - 793.349522 = 4206.650478
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("-4206.650478", usdcDecimals),
                )
                // alice's wbtc balance: 0.02355323 - 0.02355323 = 0
                expect(await vault.getBalanceByToken(alice.address, wbtc.address)).to.be.eq(
                    parseUnits("0", wbtcDecimals),
                )
                // alice's usdc balance: 793.349522
                expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("793.349522", usdcDecimals))

                // collateral liquidation insurance fund fee: 817.886106 * 0.03 = 24.536584
                expect(await vault.getBalance(insuranceFund.address)).to.be.eq(parseUnits("24.536584", usdcDecimals))

                // vault's balance
                expect(await wbtc.balanceOf(vault.address)).to.be.eq(
                    vaultWbtcBalanceBefore.sub(maxLiquidatableCollateral),
                )
                expect(await usdc.balanceOf(vault.address)).to.be.eq(
                    vaultUsdcBalanceBefore.add(parseUnits("817.886106", usdcDecimals)),
                )

                expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([weth.address, xxx.address])
            })

            it("liquidate alice's xxx token, which has lesser decimals than settlement token", async () => {
                const vaultXxxBalanceBefore = await xxx.balanceOf(vault.address)
                const vaultUsdcBalanceBefore = await usdc.balanceOf(vault.address)

                // max liquidatable amount of xxx: 1.1237
                const maxLiquidatableCollateral = (
                    await vault.getMaxRepaidSettlementAndLiquidatableCollateral(alice.address, xxx.address)
                ).maxLiquidatableCollateral

                const tx = await vault
                    .connect(carol)
                    .liquidateCollateral(alice.address, xxx.address, maxLiquidatableCollateral, false)

                // events checking
                await expect(tx).to.emit(vault, "CollateralLiquidated").withArgs(
                    alice.address,
                    xxx.address,
                    carol.address,
                    maxLiquidatableCollateral,
                    parseUnits("99.201109", usdcDecimals), // repaid amount: 102.269185 * (1 - 0.03) = 99.201109
                    parseUnits("3.068076", usdcDecimals), // collateral liquidation insurance fund fee: 102.269185 - 99.201109 = 3.068076
                    100000,
                )
                await expect(tx)
                    .to.emit(xxx, "Transfer")
                    .withArgs(vault.address, carol.address, maxLiquidatableCollateral)
                await expect(tx)
                    .to.emit(usdc, "Transfer")
                    .withArgs(carol.address, vault.address, parseUnits("102.269185", usdcDecimals))

                // carol's usdc balance: 10000 - 102.269185 = 9897.730815
                expect(await usdc.balanceOf(carol.address)).to.be.eq(parseUnits("9897.730815", usdcDecimals))
                // xxx amount: 102.269185 / (101.123456789012345678 * 0.9) = 1.1237
                expect(await xxx.balanceOf(carol.address)).to.be.eq(maxLiquidatableCollateral)

                // repaid amount: 102.269185 * (1 - 0.03) = 99.201109
                // alice's usdc debt = 5000 - 99.201109 = 4900.798891
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("-4900.798891", usdcDecimals),
                )
                // alice's xxx balance: 1.1237 - 1.1237 = 0
                expect(await vault.getBalanceByToken(alice.address, xxx.address)).to.be.eq(parseUnits("0", xxxDecimals))
                // alice's usdc balance: 99.201109
                expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("99.201109", usdcDecimals))

                // collateral liquidation insurance fund fee: 102.269185 * 0.03 = 3.068076
                expect(await vault.getBalance(insuranceFund.address)).to.be.eq(parseUnits("3.068076", usdcDecimals))

                // vault's balance
                expect(await xxx.balanceOf(vault.address)).to.be.eq(
                    vaultXxxBalanceBefore.sub(maxLiquidatableCollateral),
                )
                expect(await usdc.balanceOf(vault.address)).to.be.eq(
                    vaultUsdcBalanceBefore.add(parseUnits("102.269185", usdcDecimals)),
                )

                expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([weth.address, wbtc.address])
            })
        })
    })
})
