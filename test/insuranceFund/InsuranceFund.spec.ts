import { MockContract } from "@eth-optimism/smock"
import { loadFixture } from "@ethereum-waffle/provider"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { InsuranceFund, TestERC20 } from "../../typechain"
import { mockedInsuranceFundFixture } from "./fixtures"

describe("InsuranceFund Spec", () => {
    const [admin, alice] = waffle.provider.getWallets()
    let vault: MockContract
    let usdc: TestERC20
    let insuranceFund: InsuranceFund

    beforeEach(async () => {
        const _fixture = await loadFixture(mockedInsuranceFundFixture)
        vault = _fixture.mockedVault
        insuranceFund = _fixture.insuranceFund
    })

    it("set borrower and emit event", async () => {
        await expect(insuranceFund.setBorrower(vault.address))
            .to.emit(insuranceFund, "BorrowerChanged")
            .withArgs(vault.address)
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
    })
})
