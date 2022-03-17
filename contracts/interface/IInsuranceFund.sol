// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

interface IInsuranceFund {
    /// @param borrower The address of the borrower
    event BorrowerChanged(address borrower);

    /// @notice If bad debt happened, `Vault` contract will borrow from `InsuranceFund` contract
    /// @dev Borrower must be set by owner
    /// @param amount Borrow amount, must be less than `InsuranceFund` balance
    function borrow(uint256 amount) external;

    /// @notice Get settlement token address
    /// @return token The address of settlement token
    function getToken() external view returns (address token);

    /// @notice Get valid borrower
    /// @return borrower Should be equal to vault address
    function getBorrower() external view returns (address borrower);
}
