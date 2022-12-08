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

    describe("vault", () => {
        it("force error, not admin set vault", async () => {
            await expect(insuranceFund.connect(alice).setVault(vault.address)).to.be.revertedWith("SO_CNO")
        })

        it("force error, setVault but vault is not a contract", async () => {
            await expect(insuranceFund.setVault(admin.address)).to.revertedWith("IF_VNC")
        })

        it("set vault and emit event", async () => {
            await expect(insuranceFund.setVault(vault.address))
                .to.emit(insuranceFund, "VaultChanged")
                .withArgs(vault.address)
        })

        it("force error, setVault but vault is not a contract", async () => {
            await expect(insuranceFund.setVault(admin.address)).to.revertedWith("IF_VNC")
        })

        it("set vault and emit event", async () => {
            await expect(insuranceFund.setVault(vault.address))
                .to.emit(insuranceFund, "VaultChanged")
                .withArgs(vault.address)
        })
    })

    describe("# distributionThreshold and distributeFee()", () => {
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

            it("force error, not admin set distributionThreshold", async () => {
                await expect(insuranceFund.connect(alice).setDistributionThreshold("1")).to.be.revertedWith("SO_CNO")
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

            it("set distribution threshold and emit event", async () => {
                await expect(insuranceFund.setDistributionThreshold(parseUnits("100", usdcDecimals)))
                    .to.be.emit(insuranceFund, "DistributionThresholdChanged")
                    .withArgs(parseUnits("100", usdcDecimals))
            })
        })

        describe("distributionThreshold is not set", () => {
            it("force error on distributeFee()", async () => {
                await insuranceFund.setSurplusBeneficiary(mockSurplusBeneficiary.address)
                await expect(insuranceFund.distributeFee()).to.be.revertedWith("IF_DTEZ")
            })
        })

        describe("distributionThreshold is set", () => {
            beforeEach(async () => {
                await insuranceFund.setDistributionThreshold(parseUnits("100000", usdcDecimals))
                await insuranceFund.setSurplusBeneficiary(mockSurplusBeneficiary.address)
            })

            // case #1a
            it("will not emit event when distributionThreshold is not met (positive capacity)", async () => {
                // insuranceFund capacity: 1000
                // 1000 < 100000(distributionThreshold)
                await usdc.mint(insuranceFund.address, parseUnits("1000", usdcDecimals))

                // will not emit FeeDistributed event because surplus is zero
                await expect(insuranceFund.distributeFee()).to.be.not.emit(insuranceFund, "FeeDistributed")

                // 1000 + 100 < 100000(distributionThreshold)
                await vault.depositFor(insuranceFund.address, usdc.address, parseUnits("100", usdcDecimals))

                // will not emit FeeDistributed event because surplus is zero
                await expect(insuranceFund.distributeFee()).to.be.not.emit(insuranceFund, "FeeDistributed")
            })

            // case #1b
            it("will not emit event when distributionThreshold is not met (negative capacity)", async () => {
                // insuranceFund capacity: 200000 - 500000
                // -300000 < 100000(distributionThreshold)
                await usdc.mint(insuranceFund.address, parseUnits("200000", usdcDecimals))
                await accountBalance.testModifyOwedRealizedPnl(insuranceFund.address, parseEther("-500000"))

                // will not emit FeeDistributed event because surplus is zero
                await expect(insuranceFund.distributeFee()).to.be.not.emit(insuranceFund, "FeeDistributed")
            })

            // case #2a
            it("will not emit event when distributionThreshold is met but surplus is zero", async () => {
                // insuranceFund capacity: 200000
                // 200000 > 100000(distributionThreshold) but freeCollateral is zero
                await usdc.mint(insuranceFund.address, parseUnits("200000", usdcDecimals))

                // will not emit FeeDistributed event because surplus is zero
                await expect(insuranceFund.distributeFee()).to.be.not.emit(insuranceFund, "FeeDistributed")
            })

            // case #2b
            it("will not emit event when distributionThreshold is met (negative account value) but surplus is zero", async () => {
                // insuranceFund capacity: 200000 - 50000
                // 150000 > 100000(distributionThreshold) but freeCollateral is zero
                await usdc.mint(insuranceFund.address, parseUnits("200000", usdcDecimals))
                await accountBalance.testModifyOwedRealizedPnl(insuranceFund.address, parseEther("-50000"))

                // will not emit FeeDistributed event because surplus is zero
                await expect(insuranceFund.distributeFee()).to.be.not.emit(insuranceFund, "FeeDistributed")
            })

            // case #3
            it("distributeFee when insuranceFund earned fees, has no balance in wallet, surplus is dictated by distributionThreshold", async () => {
                await vault.depositFor(insuranceFund.address, usdc.address, parseUnits("200000", usdcDecimals))

                // insuranceFund capacity: 200000 + 0(usdc balance)
                // overDistributionThreshold = max(200000 - 100000, 0) = 100000
                // surplus = min(100000, 200000) = 100000
                await expect(insuranceFund.distributeFee()).to.be.emit(insuranceFund, "FeeDistributed").withArgs(
                    parseUnits("100000", usdcDecimals), // surplus
                    parseUnits("200000", usdcDecimals), // insuranceFundCapacity
                    parseUnits("200000", usdcDecimals), // insuranceFundFreeCollateral
                    parseUnits("100000", usdcDecimals), // distributionThreshold
                )

                const surplusBeneficiaryUsdcBalance = await usdc.balanceOf(mockSurplusBeneficiary.address)
                expect(surplusBeneficiaryUsdcBalance).to.be.eq(parseUnits("100000", usdcDecimals))
            })

            // case #4
            it("distributeFee when insuranceFund earned fees, has little balance in wallet, surplus is dictated by distributionThreshold", async () => {
                await usdc.mint(insuranceFund.address, parseUnits("50000", usdcDecimals))
                await vault.depositFor(insuranceFund.address, usdc.address, parseUnits("200000", usdcDecimals))

                // insuranceFund capacity: 200000 + 50000(usdc balance)
                // overDistributionThreshold = max(250000 - 100000, 0) = 150000
                // surplus = min(150000, 200000) = 150000
                await expect(insuranceFund.distributeFee()).to.be.emit(insuranceFund, "FeeDistributed").withArgs(
                    parseUnits("150000", usdcDecimals), // surplus
                    parseUnits("250000", usdcDecimals), // insuranceFundCapacity
                    parseUnits("200000", usdcDecimals), // insuranceFundFreeCollateral
                    parseUnits("100000", usdcDecimals), // distributionThreshold
                )

                const surplusBeneficiaryUsdcBalance = await usdc.balanceOf(mockSurplusBeneficiary.address)
                expect(surplusBeneficiaryUsdcBalance).to.be.eq(parseUnits("150000", usdcDecimals))
            })

            // case #5
            it("distributeFee when insuranceFund earned fees, has large balance in wallet, surplus is dictated by revenue", async () => {
                await usdc.mint(insuranceFund.address, parseUnits("200000", usdcDecimals))
                await vault.depositFor(insuranceFund.address, usdc.address, parseUnits("200000", usdcDecimals))

                // insuranceFund capacity: 200000 + 200000(usdc balance)
                // overDistributionThreshold = max(400000 - 100000, 0) = 300000
                // surplus = min(300000, 200000) = 200000
                await expect(insuranceFund.distributeFee()).to.be.emit(insuranceFund, "FeeDistributed").withArgs(
                    parseUnits("200000", usdcDecimals), // surplus
                    parseUnits("400000", usdcDecimals), // insuranceFundCapacity
                    parseUnits("200000", usdcDecimals), // insuranceFundFreeCollateral
                    parseUnits("100000", usdcDecimals), // distributionThreshold
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
