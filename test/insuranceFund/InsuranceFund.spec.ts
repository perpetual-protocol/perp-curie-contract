import { MockContract, smockit } from "@eth-optimism/smock"
import { loadFixture } from "@ethereum-waffle/provider"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { InsuranceFund, TestAccountBalance, TestERC20, Vault } from "../../typechain"
import { createClearingHouseFixture } from "../clearingHouse/fixtures"

describe("InsuranceFund Spec", () => {
    const [admin, alice] = waffle.provider.getWallets()
    let vault: Vault
    let usdc: TestERC20
    let usdcDecimals: number
    let insuranceFund: InsuranceFund
    let accountBalance: TestAccountBalance

    beforeEach(async () => {
        const _fixture = await loadFixture(createClearingHouseFixture(true))
        vault = _fixture.vault
        accountBalance = _fixture.accountBalance as TestAccountBalance
        usdc = _fixture.USDC
        usdcDecimals = await usdc.decimals()
        insuranceFund = _fixture.insuranceFund

        await usdc.mint(admin.address, parseUnits("200000", usdcDecimals))
        await usdc.connect(admin).approve(vault.address, ethers.constants.MaxUint256)
    })

    it("force error, invalid vault address", async () => {
        const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
        const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
        await expect(insuranceFund.initialize(admin.address)).to.be.revertedWith("IF_TNC")
    })

    describe("borrower", () => {
        it("force error, not admin set borrower", async () => {
            await expect(insuranceFund.connect(alice).setBorrower(vault.address)).to.be.revertedWith("SO_CNO")
        })

        it("force error, setBorrower but borrower is not a contract", async () => {
            await expect(insuranceFund.setBorrower(admin.address)).to.revertedWith("IF_BNC")
        })

        it("set borrower and emit event", async () => {
            await expect(insuranceFund.setBorrower(vault.address))
                .to.emit(insuranceFund, "BorrowerChanged")
                .withArgs(vault.address)
        })

        it("force error, setBorrower but borrower is not a contract", async () => {
            await expect(insuranceFund.setBorrower(admin.address)).to.revertedWith("IF_BNC")
        })

        it("set borrower and emit event", async () => {
            await expect(insuranceFund.setBorrower(vault.address))
                .to.emit(insuranceFund, "BorrowerChanged")
                .withArgs(vault.address)
        })
    })

    describe("# threshold and distributeFee()", () => {
        let mockSurplusBeneficiary: MockContract

        beforeEach(async () => {
            const testSurplusBeneficiaryFactory = await ethers.getContractFactory("SurplusBeneficiary")
            mockSurplusBeneficiary = await smockit(testSurplusBeneficiaryFactory.interface)
            mockSurplusBeneficiary.smocked.getToken.will.return.with(() => usdc.address)
        })

        describe("admin", () => {
            it("force error, not admin set surplusBeneficiary contract", async () => {
                await expect(
                    insuranceFund.connect(alice).setSurplusBeneficiary(mockSurplusBeneficiary.address),
                ).to.be.revertedWith("SO_CNO")
            })

            it("force error, not admin set threshold", async () => {
                await expect(insuranceFund.connect(alice).setThreshold("1")).to.be.revertedWith("SO_CNO")
            })

            it("force error when surplusBeneficiary is not a contract", async () => {
                await expect(insuranceFund.setSurplusBeneficiary(admin.address)).to.be.revertedWith("IF_SNC")
            })

            it("force error, surplusBeneficiary token is not match", async () => {
                mockSurplusBeneficiary.smocked.getToken.will.return.with(() => ethers.constants.AddressZero)

                await expect(
                    insuranceFund.connect(admin).setSurplusBeneficiary(mockSurplusBeneficiary.address),
                ).to.be.revertedWith("IF_TNM")
            })

            it("set SurplusBeneficiary contract and emit event", async () => {
                await expect(insuranceFund.setSurplusBeneficiary(mockSurplusBeneficiary.address))
                    .to.be.emit(insuranceFund, "SurplusBeneficiaryChanged")
                    .withArgs(mockSurplusBeneficiary.address)
            })

            it("set threshold and emit event", async () => {
                await expect(insuranceFund.setThreshold(parseUnits("100", usdcDecimals)))
                    .to.be.emit(insuranceFund, "ThresholdChanged")
                    .withArgs(parseUnits("100", usdcDecimals))
            })
        })

        describe("threshold is not set", () => {
            it("force error on distributeFee()", async () => {
                await insuranceFund.setSurplusBeneficiary(mockSurplusBeneficiary.address)
                await expect(insuranceFund.distributeFee()).to.be.revertedWith("IF_TEZ")
            })
        })

        describe("threshold is set", () => {
            beforeEach(async () => {
                await insuranceFund.setThreshold(parseUnits("100000", usdcDecimals))
                await insuranceFund.setSurplusBeneficiary(mockSurplusBeneficiary.address)
            })

            // case #1a
            it("force error when threshold is not met (positive capacity)", async () => {
                // insuranceFund capacity: 1000
                // 1000 < 100000(threshold)
                await usdc.mint(insuranceFund.address, parseUnits("1000", usdcDecimals))

                await expect(insuranceFund.distributeFee()).to.be.revertedWith("IF_NSP")

                // 1000 + 100 < 100000(threshold)
                await vault.depositFor(insuranceFund.address, usdc.address, parseUnits("100", usdcDecimals))

                await expect(insuranceFund.distributeFee()).to.be.revertedWith("IF_NSP")
            })

            // case #1b
            it("force error when threshold is not met (negative capacity)", async () => {
                // insuranceFund capacity: 200000 - 500000
                // -300000 < 100000(threshold)
                await usdc.mint(insuranceFund.address, parseUnits("200000", usdcDecimals))
                await accountBalance.testModifyOwedRealizedPnl(insuranceFund.address, parseEther("-500000"))

                await expect(insuranceFund.distributeFee()).to.be.revertedWith("IF_NSP")
            })

            // case #2a
            it("force error when threshold is met but surplus is zero", async () => {
                // insuranceFund capacity: 200000
                // 200000 > 100000(threshold) but freeCollateral is zero
                await usdc.mint(insuranceFund.address, parseUnits("200000", usdcDecimals))

                await expect(insuranceFund.distributeFee()).to.be.revertedWith("IF_NSP")
            })

            // case #2b
            it("force error when threshold is met (negative account value) but surplus is zero", async () => {
                // insuranceFund capacity: 200000 - 50000
                // 150000 > 100000(threshold) but freeCollateral is zero
                await usdc.mint(insuranceFund.address, parseUnits("200000", usdcDecimals))
                await accountBalance.testModifyOwedRealizedPnl(insuranceFund.address, parseEther("-50000"))

                await expect(insuranceFund.distributeFee()).to.be.revertedWith("IF_NSP")
            })

            // case #3
            it("distributeFee when insuranceFund earned fees, has no balance in wallet, surplus is dictated by threshold", async () => {
                await vault.depositFor(insuranceFund.address, usdc.address, parseUnits("200000", usdcDecimals))

                // insuranceFund capacity: 200000 + 0(usdc balance)
                // overThreshold = max(200000 - 100000, 0) = 100000
                // surplus = min(100000, 200000) = 100000
                await expect(insuranceFund.distributeFee()).to.be.emit(insuranceFund, "FeeDistributed").withArgs(
                    parseUnits("100000", usdcDecimals), // surplus
                    parseUnits("200000", usdcDecimals), // insuranceFundCapacity
                    parseUnits("200000", usdcDecimals), // insuranceFundFreeCollateral
                    parseUnits("100000", usdcDecimals), // threshold
                )

                const surplusBeneficiaryUsdcBalance = await usdc.balanceOf(mockSurplusBeneficiary.address)
                expect(surplusBeneficiaryUsdcBalance).to.be.eq(parseUnits("100000", usdcDecimals))
            })

            // case #4
            it("distributeFee when insuranceFund earned fees, has little balance in wallet, surplus is dictated by threshold", async () => {
                await usdc.mint(insuranceFund.address, parseUnits("50000", usdcDecimals))
                await vault.depositFor(insuranceFund.address, usdc.address, parseUnits("200000", usdcDecimals))

                // insuranceFund capacity: 200000 + 50000(usdc balance)
                // overThreshold = max(250000 - 100000, 0) = 150000
                // surplus = min(150000, 200000) = 150000
                await expect(insuranceFund.distributeFee()).to.be.emit(insuranceFund, "FeeDistributed").withArgs(
                    parseUnits("150000", usdcDecimals), // surplus
                    parseUnits("250000", usdcDecimals), // insuranceFundCapacity
                    parseUnits("200000", usdcDecimals), // insuranceFundFreeCollateral
                    parseUnits("100000", usdcDecimals), // threshold
                )

                const surplusBeneficiaryUsdcBalance = await usdc.balanceOf(mockSurplusBeneficiary.address)
                expect(surplusBeneficiaryUsdcBalance).to.be.eq(parseUnits("150000", usdcDecimals))
            })

            // case #5
            it("distributeFee when insuranceFund earned fees, has large balance in wallet, surplus is dictated by revenue", async () => {
                await usdc.mint(insuranceFund.address, parseUnits("200000", usdcDecimals))
                await vault.depositFor(insuranceFund.address, usdc.address, parseUnits("200000", usdcDecimals))

                // insuranceFund capacity: 200000 + 200000(usdc balance)
                // overThreshold = max(400000 - 100000, 0) = 300000
                // surplus = min(300000, 200000) = 200000
                await expect(insuranceFund.distributeFee()).to.be.emit(insuranceFund, "FeeDistributed").withArgs(
                    parseUnits("200000", usdcDecimals), // surplus
                    parseUnits("400000", usdcDecimals), // insuranceFundCapacity
                    parseUnits("200000", usdcDecimals), // insuranceFundFreeCollateral
                    parseUnits("100000", usdcDecimals), // threshold
                )

                const surplusBeneficiaryUsdcBalance = await usdc.balanceOf(mockSurplusBeneficiary.address)
                expect(surplusBeneficiaryUsdcBalance).to.be.eq(parseUnits("200000", usdcDecimals))
            })
        })

        describe("surplusBeneficiary is not set", () => {
            it("force error on distributeFee()", async () => {
                await expect(insuranceFund.distributeFee()).to.be.revertedWith("IF_SNS")
            })
        })
    })
})
