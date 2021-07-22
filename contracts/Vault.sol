pragma solidity 0.7.6;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { ISettlement } from "./interface/ISettlement.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { ClearingHouse } from "./ClearingHouse.sol";

contract Vault is ReentrancyGuard, Ownable {
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SafeCast for int256;
    using SignedSafeMath for int256;

    event Deposited(address indexed collateralToken, address indexed account, uint256 amount);
    event Withdrawn(address indexed collateralToken, address indexed account, uint256 amount);

    address public immutable settlementToken;
    address public clearingHouse;

    uint8 public immutable decimals;

    // TODO when multi collateral
    uint256 public maxCloseFactor;
    uint256 public minCloseFactor;
    uint256 public liquidationDiscount;
    address[] private _assetLiquidationOrder;

    // key: trader, token address
    mapping(address => mapping(address => uint256)) private _balance;
    // key: trader
    mapping(address => uint256) private _debt;

    // key: token
    // TODO: change bool to collateral factor
    mapping(address => bool) private _collateralTokenMap;
    address[] private _collateralTokens;

    constructor(address settlementTokenArg) {
        settlementToken = settlementTokenArg;
        decimals = IERC20Metadata(settlementTokenArg).decimals();

        _addCollateralToken(settlementTokenArg);
    }

    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // TODO add event
        clearingHouse = clearingHouseArg;
    }

    function deposit(
        address from,
        address token,
        uint256 amount
    ) external nonReentrant() {
        // collateralToken not found
        require(_collateralTokenMap[token], "V_CNF");

        _increaseBalance(from, token, amount);
        TransferHelper.safeTransferFrom(token, from, address(this), amount);

        emit Deposited(token, from, amount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant() {
        // TODO if the balanceOf(token) is less than amount, should swap or revert?

        address trader = _msgSender();
        // CH_NEFC: not enough free collateral
        require(
            ClearingHouse(clearingHouse).getFreeCollateral(trader) >= _getValueInSettlementToken(token, amount),
            "V_NEFC"
        );
        // V_NEB: not enough balance
        require(_getBalance(trader, token) >= amount, "V_NEB");

        _decreaseBalance(trader, token, amount);
        TransferHelper.safeTransfer(token, trader, amount);
        emit Withdrawn(token, trader, amount);
    }

    function balanceOf(address account) public view returns (uint256) {
        uint256 settlementTokenValue;
        for (uint256 i = 0; i < _collateralTokens.length; i++) {
            address token = _collateralTokens[i];
            if (settlementToken != token) {
                // TODO get twap of settlement price * account's balance
                continue;
            }
            // is settlement token
            settlementTokenValue = settlementTokenValue.add(_getBalance(account, token));
        }

        return settlementTokenValue;
    }

    function _addCollateralToken(address token) private {
        // collateral token existed
        require(!_collateralTokenMap[token], "V_CTE");
        _collateralTokenMap[token] = true;
        _collateralTokens.push(token);
    }

    function _increaseBalance(
        address account,
        address token,
        uint256 amount
    ) private {
        _balance[account][token] = _getBalance(account, token).add(amount);
    }

    function _decreaseBalance(
        address account,
        address token,
        uint256 amount
    ) private {
        _balance[account][token] = _getBalance(account, token).sub(amount);
    }

    function _liquidate(
        address account,
        address collateralToken,
        uint256 amount
    ) private {
        revert("TBD");
    }

    function _getBalance(address account, address token) private view returns (uint256) {
        return _balance[account][token];
    }

    function _getValueInSettlementToken(address token, uint256 amount) private view returns (uint256) {
        // TODO support non-settlement tokens, need a Oracle
        // V_NS: only settlement token for now
        require(token == settlementToken, "V_OSTFN");
        return amount;
    }
}
