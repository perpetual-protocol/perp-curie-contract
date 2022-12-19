import { MockContract } from "@eth-optimism/smock"
import { loadFixture } from "@ethereum-waffle/provider"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { InsuranceFund, TestAccountBalance, TestERC20, Vault } from "../../typechain"
import { createClearingHouseFixture } from "../clearingHouse/fixtures"

describe("InsuranceFund Test", () => {
    const [admin] = waffle.provider.getWallets()
    let vault: Vault
    let usdc: TestERC20
    let wbtc: TestERC20
    let mockedWbtcPriceFeed: MockContract
    let usdcDecimals: number
    let insuranceFund: InsuranceFund
    let accountBalance: TestAccountBalance

    beforeEach(async () => {
        const _fixture = await loadFixture(createClearingHouseFixture(true))
        vault = _fixture.vault
        accountBalance = _fixture.accountBalance as TestAccountBalance
        usdc = _fixture.USDC
        wbtc = _fixture.WBTC
        mockedWbtcPriceFeed = _fixture.mockedWbtcPriceFeed
        usdcDecimals = await usdc.decimals()
        insuranceFund = _fixture.insuranceFund

        await usdc.mint(admin.address, parseUnits("200000", usdcDecimals))
        await usdc.connect(admin).approve(vault.address, ethers.constants.MaxUint256)
    })

    describe("# repay()", () => {
        it("force error when IF account value is gt 0", async () => {
            await accountBalance.testModifyOwedRealizedPnl(insuranceFund.address, parseEther("100"))
            const settlementTokenValue = await vault.getSettlementTokenValue(insuranceFund.address)
            expect(settlementTokenValue).to.be.gt("0")

            await expect(insuranceFund.repay()).to.be.revertedWith("IF_RWNN")
        })

        it("repay when IF balance less than accountValue.abs()", async () => {
            await accountBalance.testModifyOwedRealizedPnl(insuranceFund.address, parseEther("-100"))
            await usdc.mint(insuranceFund.address, parseUnits("50", usdcDecimals))

            await expect(insuranceFund.repay())
                .to.be.emit(insuranceFund, "Repaid")
                .withArgs(parseUnits("50", usdcDecimals), parseUnits("0", usdcDecimals))
        })

        it("repay when IF balance greater than accountValue.abs()", async () => {
            await accountBalance.testModifyOwedRealizedPnl(insuranceFund.address, parseEther("-100"))
            await usdc.mint(insuranceFund.address, parseUnits("110", usdcDecimals))

            await expect(insuranceFund.repay())
                .to.be.emit(insuranceFund, "Repaid")
                .withArgs(parseUnits("100", usdcDecimals), parseUnits("10", usdcDecimals))
        })
    })

    describe("# getInsuranceFundCapacity()", () => {
        it("capacity is positive", async () => {
            await usdc.mint(insuranceFund.address, parseUnits("100", 6))
            await accountBalance.testModifyOwedRealizedPnl(insuranceFund.address, parseEther("100"))
            const insuranceCapacity = await insuranceFund.getInsuranceFundCapacity()
            expect(insuranceCapacity).to.be.eq(parseUnits("200", 6))
        })

        it("capacity is negative", async () => {
            await accountBalance.testModifyOwedRealizedPnl(insuranceFund.address, parseEther("-20"))
            const insuranceCapacity = await insuranceFund.getInsuranceFundCapacity()
            expect(insuranceCapacity).to.be.eq(parseUnits("-20", 6))
        })

        it("non-collateral will not affect IF capacity", async () => {
            mockedWbtcPriceFeed.smocked.getPrice.will.return.with(parseUnits("40000", 8))

            await wbtc.mint(admin.address, parseUnits("100", await wbtc.decimals()))
            await wbtc.connect(admin).approve(vault.address, ethers.constants.MaxUint256)
            await vault
                .connect(admin)
                .depositFor(insuranceFund.address, wbtc.address, parseUnits("100", await wbtc.decimals()))

            const insuranceCapacity = await insuranceFund.getInsuranceFundCapacity()
            expect(insuranceCapacity).to.be.eq("0")

            const accountValue = await vault.getAccountValue(insuranceFund.address)
            expect(accountValue).to.be.gt("0")
        })
    })
})
