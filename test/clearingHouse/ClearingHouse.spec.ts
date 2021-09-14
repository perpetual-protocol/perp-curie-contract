import { MockContract, smockit } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, UniswapV3Pool } from "../../typechain"
import { mockedClearingHouseFixture } from "./fixtures"

describe("ClearingHouse Spec", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const DEFAULT_FEE = 3000

    let clearingHouse: ClearingHouse
    let baseToken: MockContract
    let quoteToken: MockContract
    let uniV3Factory: MockContract
    let exchange: MockContract
    let insuranceFund: MockContract
    let vault: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(mockedClearingHouseFixture)
        clearingHouse = _clearingHouseFixture.clearingHouse
        baseToken = _clearingHouseFixture.mockedBaseToken
        quoteToken = _clearingHouseFixture.mockedQuoteToken
        uniV3Factory = _clearingHouseFixture.mockedUniV3Factory
        exchange = _clearingHouseFixture.mockedExchange
        insuranceFund = _clearingHouseFixture.mockedInsuranceFund
        vault = _clearingHouseFixture.mockedVault

        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })

        baseToken.smocked.getIndexPrice.will.return.with(parseEther("100"))
    })

    describe("# initialize", () => {
        it("force error, invalid vault address", async () => {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
            await expect(
                clearingHouse.initialize(
                    wallet.address,
                    insuranceFund.address,
                    quoteToken.address,
                    uniV3Factory.address,
                ),
            ).to.be.revertedWith("CH_VANC")
        })

        it("force error, invalid insuranceFund address", async () => {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
            await expect(
                clearingHouse.initialize(vault.address, wallet.address, quoteToken.address, uniV3Factory.address),
            ).to.be.revertedWith("CH_IFANC")
        })

        it("force error, invalid quote token address", async () => {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
            await expect(
                clearingHouse.initialize(vault.address, insuranceFund.address, wallet.address, uniV3Factory.address),
            ).to.be.revertedWith("CH_QANC")
        })

        it("force error, invalid uniV3Factory address", async () => {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
            await expect(
                clearingHouse.initialize(vault.address, insuranceFund.address, quoteToken.address, wallet.address),
            ).to.be.revertedWith("CH_UANC")
        })
    })

    describe("onlyOwner setters", () => {
        it("setLiquidationPenaltyRatio", async () => {
            await expect(clearingHouse.setLiquidationPenaltyRatio(2e6)).to.be.revertedWith("CH_RO")
            await expect(clearingHouse.setLiquidationPenaltyRatio("500000")) // 50%
                .to.emit(clearingHouse, "LiquidationPenaltyRatioChanged")
                .withArgs(500000)
            expect(await clearingHouse.liquidationPenaltyRatio()).eq(500000)
        })

        it("setPartialCloseRatio", async () => {
            await expect(clearingHouse.setPartialCloseRatio(2e6)).to.be.revertedWith("CH_RO")
            await expect(clearingHouse.setPartialCloseRatio("500000")) // 50%
                .to.emit(clearingHouse, "PartialCloseRatioChanged")
                .withArgs(500000)
            expect(await clearingHouse.partialCloseRatio()).eq(500000)
        })

        it("setTwapInterval", async () => {
            await expect(clearingHouse.setTwapInterval(0)).to.be.revertedWith("CH_ITI")
            await expect(clearingHouse.setTwapInterval(3600))
                .to.emit(clearingHouse, "TwapIntervalChanged")
                .withArgs(3600)
            expect(await clearingHouse.twapInterval()).eq(3600)
        })

        it("setMaxTickCrossedWithinBlock", async () => {
            exchange.smocked.getPool.will.return.with(EMPTY_ADDRESS)
            await expect(clearingHouse.setMaxTickCrossedWithinBlock(baseToken.address, 200)).to.be.revertedWith(
                "CH_BTNE",
            )

            // add pool
            const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            const pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            const mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
            mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            exchange.smocked.getPool.will.return.with(mockedPool.address)

            await clearingHouse.setMaxTickCrossedWithinBlock(baseToken.address, 200)
            expect(await clearingHouse.getMaxTickCrossedWithinBlock(baseToken.address)).eq(200)

            // out of range [0, 887272]
            await expect(clearingHouse.setMaxTickCrossedWithinBlock(baseToken.address, 1e6)).to.be.revertedWith(
                "CH_MTCLOOR",
            )
        })

        it("force error, invalid exchange address when setExchange", async () => {
            await expect(clearingHouse.setExchange(wallet.address)).to.be.revertedWith("CH_ANC")
        })

        it("force error, invalid base token address when setMaxTickCrossedWithinBlock", async () => {
            await expect(clearingHouse.setMaxTickCrossedWithinBlock(wallet.address, 1)).to.be.revertedWith("CH_ANC")
        })

        it("force error, invalid trustedForwarder address when setTrustedForwarder", async () => {
            await expect(clearingHouse.setTrustedForwarder(wallet.address)).to.be.revertedWith("CH_ANC")
        })
    })

    describe("# getRequiredCollateral", () => {})
})
