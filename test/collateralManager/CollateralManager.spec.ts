import { expect } from "chai"
import { BigNumberish } from "ethers/lib/ethers"
import { parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouseConfig, CollateralManager, TestERC20, Vault } from "../../typechain"
import { ChainlinkPriceFeedV2 } from "../../typechain/perp-oracle"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"

describe("CollateralManager spec", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let collateralManager: CollateralManager
    let USDC: TestERC20
    let USDT: TestERC20
    let WETH: TestERC20
    let WBTC: TestERC20
    let priceFeed: ChainlinkPriceFeedV2
    let clearingHouseConfig: ClearingHouseConfig
    let vault: Vault
    let skipInitializeCollateralManagerInBeforeEach = false

    const initializeCollateralManager = ({
        clearingHouseConfigArg,
        vaultArg,
        maxCollateralTokensPerAccountArg,
        debtNonSettlementTokenValueRatioArg,
        liquidationRatioArg,
        mmRatioBufferArg,
        clInsuranceFundFeeRatioArg,
        debtThresholdArg,
        collateralValueDustArg,
    }: {
        clearingHouseConfigArg?: string
        vaultArg?: string
        maxCollateralTokensPerAccountArg?: BigNumberish
        debtNonSettlementTokenValueRatioArg?: BigNumberish
        liquidationRatioArg?: BigNumberish
        mmRatioBufferArg?: BigNumberish
        clInsuranceFundFeeRatioArg?: BigNumberish
        debtThresholdArg?: BigNumberish
        collateralValueDustArg?: BigNumberish
    } = {}) => {
        return collateralManager.initialize(
            clearingHouseConfigArg || clearingHouseConfig.address,
            vaultArg || vault.address,
            maxCollateralTokensPerAccountArg || 5,
            debtNonSettlementTokenValueRatioArg || "800000",
            liquidationRatioArg || "500000",
            mmRatioBufferArg || "2000",
            clInsuranceFundFeeRatioArg || "30000",
            debtThresholdArg || parseEther("10000"),
            collateralValueDustArg || parseEther("500"),
        )
    }

    beforeEach(async () => {
        collateralManager = (await (await ethers.getContractFactory("CollateralManager")).deploy()) as CollateralManager

        const tokenFactory = await ethers.getContractFactory("TestERC20")
        USDT = (await tokenFactory.deploy()) as TestERC20
        await USDT.__TestERC20_init("TestUSDC", "USDT", 6)
        WETH = (await tokenFactory.deploy()) as TestERC20
        await WETH.__TestERC20_init("TestWETH", "WETH", 18)
        WBTC = (await tokenFactory.deploy()) as TestERC20
        await WBTC.__TestERC20_init("TestWBTC", "WBTC", 6)

        const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
        const aggregator = await aggregatorFactory.deploy()
        const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeedV2")
        priceFeed = (await chainlinkPriceFeedFactory.deploy(aggregator.address, 0)) as ChainlinkPriceFeedV2
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouseConfig = fixture.clearingHouseConfig
        vault = fixture.vault
        USDC = fixture.USDC

        if (!skipInitializeCollateralManagerInBeforeEach) {
            await initializeCollateralManager()
        }
    })

    describe("# initialize", () => {
        before(() => {
            skipInitializeCollateralManagerInBeforeEach = true
        })

        after(() => {
            skipInitializeCollateralManagerInBeforeEach = false
        })

        it("initialize correctly", async () => {
            const initializeTx = await initializeCollateralManager()
            await expect(initializeTx)
                .to.emit(collateralManager, "ClearingHouseConfigChanged")
                .withArgs(clearingHouseConfig.address)
            await expect(initializeTx).to.emit(collateralManager, "VaultChanged").withArgs(vault.address)
            await expect(initializeTx).to.emit(collateralManager, "MaxCollateralTokensPerAccountChanged").withArgs(5)
            await expect(initializeTx)
                .to.emit(collateralManager, "DebtNonSettlementTokenValueRatioChanged")
                .withArgs(800000)
            await expect(initializeTx).to.emit(collateralManager, "MmRatioBufferChanged").withArgs(2000)
            await expect(initializeTx).to.emit(collateralManager, "LiquidationRatioChanged").withArgs(500000)
            await expect(initializeTx).to.emit(collateralManager, "CLInsuranceFundFeeRatioChanged").withArgs(30000)
            await expect(initializeTx).to.emit(collateralManager, "DebtThresholdChanged").withArgs(parseEther("10000"))
            await expect(initializeTx)
                .to.emit(collateralManager, "CollateralValueDustChanged")
                .withArgs(parseEther("500"))

            expect(await collateralManager.getMaxCollateralTokensPerAccount()).to.be.eq(5)
            expect(await collateralManager.getMmRatioBuffer()).to.be.eq(2000)
            expect(await collateralManager.getDebtNonSettlementTokenValueRatio()).to.be.eq(800000)
            expect(await collateralManager.getLiquidationRatio()).to.be.eq(500000)
            expect(await collateralManager.getCLInsuranceFundFeeRatio()).to.be.eq(30000)
            expect(await collateralManager.getDebtThreshold()).to.be.eq(parseEther("10000"))
            expect(await collateralManager.getCollateralValueDust()).to.be.eq(parseEther("500"))
            expect(await collateralManager.getClearingHouseConfig()).to.be.eq(clearingHouseConfig.address)
            expect(await collateralManager.getVault()).to.be.eq(vault.address)
        })

        describe("force error", async () => {
            it("clearing house config is not a valid contract address", async () => {
                await expect(
                    initializeCollateralManager({
                        clearingHouseConfigArg: alice.address,
                    }),
                ).to.be.revertedWith("CM_CHCNC")
            })

            it("vault is not a valid contract address", async () => {
                await expect(
                    initializeCollateralManager({
                        vaultArg: alice.address,
                    }),
                ).to.be.revertedWith("CM_VNC")
            })

            it("invalid ratio (debtNonSettlementTokenValueRatioArg > 1)", async () => {
                await expect(
                    initializeCollateralManager({
                        debtNonSettlementTokenValueRatioArg: "1100000",
                    }),
                ).to.be.revertedWith("CM_IR")
            })

            it("invalid ratio (liquidationRatioArg > 1)", async () => {
                await expect(
                    initializeCollateralManager({
                        liquidationRatioArg: "1100000",
                    }),
                ).to.be.revertedWith("CM_IR")
            })

            it("invalid ratio (clInsuranceFundFeeRatioArg > 1)", async () => {
                await expect(
                    initializeCollateralManager({
                        clInsuranceFundFeeRatioArg: "1100000",
                    }),
                ).to.be.revertedWith("CM_IR")
            })

            it("invalid ratio (mmRatio + mmRatioBuffer > 1)", async () => {
                await expect(
                    initializeCollateralManager({
                        mmRatioBufferArg: "9500000",
                    }),
                ).to.be.revertedWith("CM_ICMR")
            })
        })
    })

    describe("# admin only function", () => {
        it("force error, only owner can call external non-view functions", async () => {
            const config = {
                priceFeed: priceFeed.address,
                collateralRatio: (0.7e6).toString(),
                discountRatio: (0.1e6).toString(),
                depositCap: parseEther("1000000"),
            }

            await expect(collateralManager.connect(alice).addCollateral(USDT.address, config)).to.be.revertedWith(
                "SO_CNO",
            )

            await expect(
                collateralManager.connect(alice).setPriceFeed(USDT.address, priceFeed.address),
            ).to.be.revertedWith("SO_CNO")

            await expect(collateralManager.connect(alice).setCollateralRatio(WETH.address, "1000")).to.be.revertedWith(
                "SO_CNO",
            )

            await expect(collateralManager.connect(alice).setDiscountRatio(WETH.address, "1000")).to.be.revertedWith(
                "SO_CNO",
            )

            await expect(
                collateralManager.connect(alice).setDepositCap(WETH.address, parseEther("1000")),
            ).to.be.revertedWith("SO_CNO")

            await expect(collateralManager.connect(alice).setMaxCollateralTokensPerAccount(2)).to.be.revertedWith(
                "SO_CNO",
            )

            await expect(collateralManager.connect(alice).setMmRatioBuffer("1000")).to.be.revertedWith("SO_CNO")

            await expect(
                collateralManager.connect(alice).setDebtNonSettlementTokenValueRatio("800000"),
            ).to.be.revertedWith("SO_CNO")

            await expect(collateralManager.connect(alice).setLiquidationRatio("100000")).to.be.revertedWith("SO_CNO")

            await expect(collateralManager.connect(alice).setCLInsuranceFundFeeRatio("100000")).to.be.revertedWith(
                "SO_CNO",
            )

            await expect(collateralManager.connect(alice).setCollateralValueDust("100000")).to.be.revertedWith("SO_CNO")
        })
    })

    describe("# setDebtNonSettlementTokenValueRatio", () => {
        it("update debt non-settlement token value ratio (< 1)", async () => {
            await expect(collateralManager.setDebtNonSettlementTokenValueRatio("800000")).to.emit(
                collateralManager,
                "DebtNonSettlementTokenValueRatioChanged",
            )

            expect(await collateralManager.getDebtNonSettlementTokenValueRatio()).to.be.eq(800000)
        })

        it("force error, invalid liquidation ratio(> 1)", async () => {
            await expect(collateralManager.setDebtNonSettlementTokenValueRatio("1200000")).to.be.revertedWith("CM_IR")
        })
    })

    describe("# setLiquidationRatio", () => {
        it("update liquidation ratio", async () => {
            await expect(collateralManager.setLiquidationRatio("100000")).to.emit(
                collateralManager,
                "LiquidationRatioChanged",
            )

            expect(await collateralManager.getLiquidationRatio()).to.be.eq(100000)
        })

        it("force error, invalid liquidation ratio", async () => {
            await expect(collateralManager.setLiquidationRatio("2000000")).to.be.revertedWith("CM_IR")
        })
    })

    describe("# setCLInsuranceFundFeeRatio", () => {
        it("update collateral liquidation insurance fund fee ratio", async () => {
            await expect(collateralManager.setCLInsuranceFundFeeRatio("100000")).to.emit(
                collateralManager,
                "CLInsuranceFundFeeRatioChanged",
            )

            expect(await collateralManager.getCLInsuranceFundFeeRatio()).to.be.eq(100000)
        })

        it("force error, invalid collateral liquidation insurance fund fee ratio", async () => {
            await expect(collateralManager.setCLInsuranceFundFeeRatio("2000000")).to.be.revertedWith("CM_IR")
        })
    })

    describe("# setMmRatioBuffer", () => {
        it("update maintenance margin ratio buffer", async () => {
            await expect(collateralManager.setMmRatioBuffer("1000")).to.emit(collateralManager, "MmRatioBufferChanged")

            expect(await collateralManager.getMmRatioBuffer()).to.be.eq(1000)
        })
    })

    describe("# setMaxCollateralTokensPerAccount", () => {
        it("update max collateral tokens per account", async () => {
            await expect(collateralManager.setMaxCollateralTokensPerAccount(30)).to.emit(
                collateralManager,
                "MaxCollateralTokensPerAccountChanged",
            )

            expect(await collateralManager.getMaxCollateralTokensPerAccount()).to.be.eq(30)
        })
    })

    describe("# setDebtThreshold", () => {
        it("update debt threshold", async () => {
            await expect(collateralManager.setDebtThreshold(parseEther("2000"))).to.emit(
                collateralManager,
                "DebtThresholdChanged",
            )

            expect(await collateralManager.getDebtThreshold()).to.be.eq(parseEther("2000"))
        })

        it("force error, invalid debt threshold", async () => {
            await expect(collateralManager.setDebtThreshold("0")).to.be.revertedWith("CM_ZDT")
        })
    })

    describe("# setWhitelistedDebtThreshold", () => {
        it("increase whitelisted debt threshold", async () => {
            await expect(collateralManager.setWhitelistedDebtThreshold(alice.address, parseEther("2000"))).to.emit(
                collateralManager,
                "WhitelistedDebtThresholdChanged",
            )

            expect(await collateralManager.getDebtThresholdByTrader(alice.address)).to.be.eq(parseEther("2000"))
            expect(await collateralManager.getTotalWhitelistedDebtThreshold()).to.be.eq(parseEther("2000"))
        })

        it("decrease whitelisted debt threshold", async () => {
            await collateralManager.setWhitelistedDebtThreshold(alice.address, parseEther("2000"))
            await collateralManager.setWhitelistedDebtThreshold(alice.address, parseEther("100"))

            expect(await collateralManager.getDebtThresholdByTrader(alice.address)).to.be.eq(parseEther("100"))
            expect(await collateralManager.getTotalWhitelistedDebtThreshold()).to.be.eq(parseEther("100"))
        })

        it("total whitelisted debt threshold", async () => {
            await collateralManager.setWhitelistedDebtThreshold(alice.address, parseEther("2000"))
            await collateralManager.setWhitelistedDebtThreshold(bob.address, parseEther("300"))
            expect(await collateralManager.getTotalWhitelistedDebtThreshold()).to.be.eq(parseEther("2300"))

            await collateralManager.setWhitelistedDebtThreshold(alice.address, parseEther("3000"))
            await collateralManager.setWhitelistedDebtThreshold(bob.address, parseEther("400"))
            expect(await collateralManager.getTotalWhitelistedDebtThreshold()).to.be.eq(parseEther("3400"))
        })
    })

    describe("# setCollateralValueDust", () => {
        it("update collateral value dust", async () => {
            await expect(collateralManager.setCollateralValueDust("100000")).to.emit(
                collateralManager,
                "CollateralValueDustChanged",
            )

            expect(await collateralManager.getCollateralValueDust()).to.be.eq("100000")
        })
    })

    describe("# add collateral", () => {
        it("add USDT as collateral", async () => {
            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            )
                .to.emit(collateralManager, "CollateralAdded")
                .withArgs(USDT.address, priceFeed.address, 700000, 100000, parseEther("1000000"))

            const config = await collateralManager.getCollateralConfig(USDT.address)
            expect(config).to.be.deep.eq([priceFeed.address, 700000, 100000, parseEther("1000000")])
        })

        it("force error, collateral token already exists", async () => {
            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.emit(collateralManager, "CollateralAdded")

            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.be.revertedWith("CM_CTE")
        })

        it("force error, invalid collateral token", async () => {
            await expect(
                collateralManager.addCollateral(alice.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.be.revertedWith("CM_CTNC")
        })

        it("force error, invalid price feed address", async () => {
            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: alice.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.be.revertedWith("CM_PFNC")
        })

        it("force error, invalid ratio", async () => {
            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (1.2e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.be.revertedWith("CM_IR")

            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (1.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.be.revertedWith("CM_IR")
        })

        it("force error, collateral token is settlement token", async () => {
            await expect(
                collateralManager.addCollateral(USDC.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.be.revertedWith("CM_CIS")
        })

        // TODO WIP
        it("force error, ERC20 without decimals", async () => {})
    })

    describe("# setPriceFeed", () => {
        beforeEach(async () => {
            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.emit(collateralManager, "CollateralAdded")
        })

        it("update USDT price feed", async () => {
            const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
            const aggregator = await aggregatorFactory.deploy()
            const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeedV2")
            const newPriceFeed = (await chainlinkPriceFeedFactory.deploy(aggregator.address, 0)) as ChainlinkPriceFeedV2

            await expect(collateralManager.setPriceFeed(USDT.address, newPriceFeed.address)).to.emit(
                collateralManager,
                "PriceFeedChanged",
            )

            const config = await collateralManager.getCollateralConfig(USDT.address)
            expect(config.priceFeed).to.be.eq(newPriceFeed.address)

            // TODO should verify if getPriceFeedDecimals() returns the correct number
        })

        it("force error, collateral token does not exist", async () => {
            await expect(collateralManager.setPriceFeed(WETH.address, priceFeed.address)).to.be.revertedWith("CM_TINAC")
        })

        it("force error, invalid price feed address", async () => {
            await expect(collateralManager.setPriceFeed(USDT.address, alice.address)).to.be.revertedWith("CM_PFNC")
        })
    })

    describe("# setCollateralRatio", () => {
        beforeEach(async () => {
            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.emit(collateralManager, "CollateralAdded")
        })

        it("update collateral ratio", async () => {
            await expect(collateralManager.setCollateralRatio(USDT.address, (0.8e6).toString())).to.emit(
                collateralManager,
                "CollateralRatioChanged",
            )

            const config = await collateralManager.getCollateralConfig(USDT.address)
            expect(config.collateralRatio).to.be.eq(0.8e6)
        })

        it("force error, collateral token does not exist", async () => {
            await expect(collateralManager.setCollateralRatio(WETH.address, (0.8e6).toString())).to.be.revertedWith(
                "CM_TINAC",
            )
        })

        it("force error, invalid collateral ratio", async () => {
            await expect(collateralManager.setCollateralRatio(USDT.address, (1.2e6).toString())).to.be.revertedWith(
                "CM_IR",
            )
        })
    })

    describe("# setDiscountRatio", () => {
        beforeEach(async () => {
            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.emit(collateralManager, "CollateralAdded")
        })

        it("update discount ratio", async () => {
            await expect(collateralManager.setDiscountRatio(USDT.address, (0.2e6).toString())).to.emit(
                collateralManager,
                "DiscountRatioChanged",
            )

            const config = await collateralManager.getCollateralConfig(USDT.address)
            expect(config.discountRatio).to.be.eq(0.2e6)
        })

        it("force error, collateral token does not exist", async () => {
            await expect(collateralManager.setDiscountRatio(WETH.address, (0.2e6).toString())).to.be.revertedWith(
                "CM_TINAC",
            )
        })

        it("force error, invalid discount ratio", async () => {
            await expect(collateralManager.setDiscountRatio(USDT.address, (1.2e6).toString())).to.be.revertedWith(
                "CM_IR",
            )
        })
    })

    describe("# setDepositCap", () => {
        beforeEach(async () => {
            await expect(
                collateralManager.addCollateral(USDT.address, {
                    priceFeed: priceFeed.address,
                    collateralRatio: (0.7e6).toString(),
                    discountRatio: (0.1e6).toString(),
                    depositCap: parseEther("1000000"),
                }),
            ).to.emit(collateralManager, "CollateralAdded")
        })

        it("update deposit cap", async () => {
            await expect(collateralManager.setDepositCap(USDT.address, parseEther("2000000"))).to.emit(
                collateralManager,
                "DepositCapChanged",
            )

            const config = await collateralManager.getCollateralConfig(USDT.address)
            expect(config.depositCap).to.be.eq(parseEther("2000000"))
        })

        it("force error, collateral token does not exist", async () => {
            await expect(collateralManager.setDepositCap(WETH.address, parseEther("2000000"))).to.be.revertedWith(
                "CM_TINAC",
            )
        })
    })
})
